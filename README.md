# GRAUS Fleet Kiosk — Cruscotto per TV in magazzino

Pagina web standalone (non un Add-In Geotab) pensata per girare a schermo
intero su un browser collegato a una TV. Mostra mappa live della flotta,
KPI, e una classifica costruttiva delle soste — senza bisogno che nessuno
sia loggato in MyGeotab davanti allo schermo.

## Architettura

```
TV (Chrome kiosk) → questa pagina statica → /api/fleet (funzione serverless) → Geotab
```

Le credenziali Geotab vivono SOLO nella funzione serverless (lato server,
mai visibili nel browser).

## Passo 1 — Crea un utente di servizio dedicato in Geotab

Non riusare le tue credenziali personali. In MyGeotab:

1. Amministrazione → Utenti → Aggiungi utente
2. Nome tipo `kiosk-magazzino@graus.bz.it` (può essere un indirizzo email
   che non esiste davvero, Geotab non lo verifica per l'invio)
3. Assegna un ruolo/clearance di **sola visualizzazione** (View Only /
   Read Only se disponibile nel vostro database) — questo utente deve
   solo leggere posizioni e viaggi, mai poter modificare nulla
4. Imposta una password robusta e salvatela da qualche parte sicuro
   (es. gestore password aziendale), non serve che la ricordi una persona

## Passo 2 — Deploy su Vercel

```bash
cd graus-fleet-kiosk
vercel --prod
```

Alla prima esecuzione ti chiederà di collegare/creare un progetto — dagli
un nome tipo `graus-fleet-kiosk`.

## Passo 3 — Configura le variabili d'ambiente

Su [vercel.com](https://vercel.com), apri il progetto appena creato →
**Settings → Environment Variables**, e aggiungi:

| Nome | Valore |
|---|---|
| `GEOTAB_DATABASE` | `grau01` |
| `GEOTAB_USERNAME` | l'email dell'utente di servizio creato al Passo 1 |
| `GEOTAB_PASSWORD` | la sua password |

Dopo averle aggiunte, rilancia il deploy perché vengano applicate:

```bash
vercel --prod
```

## Passo 4 — Apri la pagina

L'URL sarà tipo `https://graus-fleet-kiosk.vercel.app` — aprilo in un
browser qualsiasi per testare prima ancora di avere il mini-PC collegato
alla TV.

## Nota sulla riservatezza dell'URL

Questa pagina, una volta online, è raggiungibile da chiunque conosca
l'indirizzo — mostra posizione dei veicoli e dati aziendali. Non contiene
nomi di conducenti (come deciso), ma resta comunque prudente non
condividere pubblicamente il link. Due opzioni se si vuole un filo in più
di protezione, da valutare più avanti:

- **Vercel Deployment Protection** (password semplice richiesta prima di
  vedere la pagina) — disponibile nei piani Vercel Pro
- Un percorso "segreto" non indicizzabile (es. `/kiosk-a7f3d9`) invece
  della root — riduce il rischio di essere trovato per caso, anche se
  non è vera sicurezza

Per ora, in fase di test, va bene così.

## Variabili d'ambiente opzionali

| Nome | Descrizione | Default |
|---|---|---|
| `TEAM_MONTHLY_KM_GOAL` | Obiettivo km mensile mostrato nella dashboard Performance | 5000 |

## Personalizzazione futura

- **Soglia soste brevi**: attualmente ignoro le soste sotto i 2 minuti
  (semafori, ecc.) — modifica `MIN_STOP_SECONDS` in `api/fleet.js`
- **Aree clienti**: fase 2, non ancora implementata — richiede incrociare
  la posizione delle soste con le Zone Geotab definite in mappa
- **Nome conducente**: deciso di ometterlo per ora — se in futuro si
  decide di aggiungerlo (dopo verifica con consulente del lavoro/RSU),
  va aggiunto sia in `api/fleet.js` (leggendo l'utente assegnato al
  device tramite l'entità `DeviceStatusInfo` o `Trip.driver`) sia nella UI
- **Più viste per più TV**: si può aggiungere un parametro URL tipo
  `?view=soste` per far mostrare a un secondo schermo solo il pannello
  soste a schermo intero, invece della vista composita attuale
