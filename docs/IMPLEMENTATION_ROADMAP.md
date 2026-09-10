# LLM Squeeze — stato e roadmap eseguibile

Stato rilevato: 2026-09-10

## Stato attuale

La base locale è solida: TypeScript strict, SQLite/WAL, 234 test, CLI, dashboard,
MCP stdio/HTTP, installazione macOS/Linux e un provider registry che separa budget
ed esecuzione. Claude è il profilo automatico; Codex dispone già di un backend
`codex exec --json` con sandbox esplicita, ma è correttamente manual-only perché
non possiede ancora una fonte quota machine-readable affidabile.

Sono già presenti, e quindi non vanno reimplementati, i seguenti elementi:

- cache `latest.json` per provider/profilo con stati healthy/stale/unavailable;
- metadati task per titolo, provider/profilo/modello, categoria, pausa, ordine e
  modalità `manual`/`priority`;
- planner puro deterministico, preview/run queue, policy di routing e riserva
  manuale, timer persistenti e receipt delle decisioni;
- pacing, deadline admission, preflight senza modello, output reduction e stime
  adattive;
- dashboard e API per impostazioni e una parte del CRUD task.

Il rischio principale non era la mancanza di un'altra feature, ma la coerenza dei
metadati: un upsert parziale poteva sostituire i campi non forniti. È stato corretto
in questa iterazione; le receipt sono inoltre interrogabili via MCP e i vincoli
foreign-key SQLite sono attivi per connessione.

## Gap prioritari

| Priorità | Gap | Impatto | Esito richiesto |
|---|---|---|---|
| P0 | Backend effettivo non ancora scelto dal profilo task in tutti i percorsi | Un task non-Claude non deve mai cadere implicitamente su Claude | Risoluzione backend centralizzata e fail-closed |
| P0 | `runNightLoop` e `paced-executor` restano due percorsi | Policy e receipt possono divergere | Un solo service di dispatch con un planner comune |
| P1 | Task/run persistono provider e profilo solo nei metadati/receipt | Audit storico incompleto | Run con backend/profilo/modello/config snapshot effettivi |
| P1 | Dashboard non espone l'intero workspace e l'audit | MCP e UI non sono equivalenti | CRUD, preview, receipt e timer in dashboard |
| P2 | Migrazioni sono implicite in `CREATE/ALTER` | Upgrade difficili da controllare | Migration runner versionato, idempotente e testato |
| P2 | Codex non ha budget source | Non può entrare in auto-routing | Spike con fixture redatte e contract test, oppure resta manual-only |

### Implementato nel blocco P0 (2026-09-10)

- `resolveBackend` è l'unico punto che risolve `(providerId, profileId)` e
  verifica capability di permission; profili assenti falliscono prima del claim.
- Il registry include Codex come backend esplicito `codex-manual`, ma il dispatch
  automatico lo rifiuta con `budget_unavailable`; Claude resta l'unico profilo
  automatico predefinito.
- `run_now` usa il backend del profilo task e non applica guard Claude a un run
  manuale non-Claude; `queue preview`, `run_queue`, CLI e paced dispatcher
  riportano gli stessi reason code di dispatch.
- Il precedente `runNightLoop` è ora un entrypoint compatibile verso il paced
  dispatcher: sono preservati floor/low-usage-hour, night confirmation, pacing,
  preflight e lock, senza un secondo percorso di admission.

## Roadmap di implementazione

### Fase 1 — Sicurezza e coerenza del dispatch (P0)

1. Introdurre un `RunService` che riceve task + scheduling metadata e risolve il
   backend nel registry tramite `(providerId, profileId)`.
2. Rendere fallimento esplicito `backend_unavailable`, prima del claim, se il
   profilo non è registrato o non supporta la permission class del task.
3. Consentire dispatch automatico solo quando esistono sia backend sia
   `BudgetSource` healthy per il medesimo profilo; Codex resta manual-only.
4. Far usare a preview, `run_queue`, CLI `queue`, `paced-executor` e night loop
   la stessa funzione e gli stessi reason code.
5. Registrare una receipt per ogni decisione valutata (ammessa o esclusa), non
   solo per quella avviata.

Criteri di accettazione: un task `codex/codex-manual` non parte mai tramite un
percorso automatico; un profilo inesistente non viene claimato; preview e dispatch
restituiscono lo stesso ordinamento e reason code a parità di input.

### Fase 2 — Modello run e migrazioni (P1/P2)

Stato: **in corso**. È presente una migration v1 idempotente e ogni nuova run
registra provider, profilo, backend, permission class, cwd/worktree, receipt e
snapshot config/budget. Restano il migration test da una copia di DB legacy e il
namespace provider/profile degli eventi di usage.

1. Aggiungere migration runner con tabella `schema_migrations`, checksum e test di
   upgrade da un DB creato dalla release corrente.
2. Spostare su `task_runs` provider, profilo, backend id, modello effettivo,
   permission profile, working directory/worktree, receipt id e snapshot di
   configurazione/budget.
3. Namespacare `usage_events.message_id` per provider/profilo prima di introdurre
   una seconda sorgente usage.
4. Conservare task e run esistenti con valori Claude nullable/conservativi;
   nessuna migrazione introduce archive o revision history, che non sono requisiti.

Criteri di accettazione: upgrade ripetibile senza perdita; ogni nuova run è
attribuibile al backend che l'ha realmente eseguita; rollback logico possibile dal
backup automatico precedente alla migrazione.

### Fase 3 — Workspace e interfacce equivalenti (P1)

1. Completare dashboard task CRUD: prompt, titolo Markdown, provider/profilo,
   categoria, pausa, ordine, intent e deadline.
2. Mostrare preview batch, run in corso, timer e ultime receipt con reason code e
   snapshot leggibile; sanitizzare l'eventuale preview Markdown.
3. Aggiungere CLI ergonomica: `task edit`, `task pause/resume`, `queue preview`,
   `queue run`, `schedule …`, `override on|off` senza JSON obbligatorio.
4. Mantenere delete permanente come azione esplicita e rifiutare delete di run
   attive.

Criteri di accettazione: ogni modifica fattibile in dashboard è fattibile in MCP;
un utente può spiegare perché un task non parte senza leggere log interni.

### Fase 4 — Provider e routing prudente (P2)

1. Completare lo spike Codex con output `--json` redatto, parsing versionato e
   contract fixture; non inferire percentuali da token/costo.
2. Rendere il backend Codex manual-only disponibile soltanto con profilo esplicito,
   sandbox `read-only`/`workspace-write`, mai `--yolo`.
3. Aggiungere un budget source Codex solo quando la telemetria è supportata,
   fresca e machine-readable; fino ad allora routing/pacing/fallback automatici
   lo escludono.
4. Abilitare fallback solo con opt-in, stessa o minore permission class e una
   receipt che indichi profilo primario, fallback e causa.

Criteri di accettazione: nessuna percentuale fra provider viene sommata o
comparata; failure di telemetria blocca l'auto-dispatch di quel profilo ma non
l'esecuzione manuale autorizzata.

### Fase 5 — Hardening e release (P2)

1. Consolidare il dispatch in un solo loop con lock globale MVP e lane per
   repository scrivibile.
2. Aggiungere test di concorrenza, recovery, migration, policy e integrazione
   HTTP; eseguire HTTP test in un ambiente che consenta il bind loopback.
3. Rendere obbligatori CI, typecheck, unit/integration test e controllo branding
   su `main`; verificare clone/install/doctor/update dallo slug GitHub finale.
4. Documentare retention raw artifact e diagnosi provider nel `doctor`.

Criteri di accettazione: CI verde su Linux e macOS; installazione pulita e
upgrade preservano dati; scheduler non avvia due run sullo stesso workspace
scrivibile.

## Sequenza raccomandata

Eseguire Fase 1 come prossimo changeset, poi Fase 2 prima di ampliare la UI.
Fasi 3 e 4 possono avanzare in parallelo solo dopo che il modello run e il service
di dispatch hanno una singola fonte di verità. La release multi-provider richiede
il completamento di tutte le condizioni P0/P1; Codex budget-aware resta opzionale.
