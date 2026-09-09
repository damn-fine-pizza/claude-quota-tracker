# LLM Squeeze — roadmap dei prossimi passi

Stato: 2026-09-09

## Decisioni già chiuse

- Nome prodotto, repository e binario: **LLM Squeeze** / `llm-squeeze`.
- Le PR #10, #11 e #12 sono in `main`.
- Un task può essere eliminato definitivamente insieme alla sua run history; non sono richiesti archive/restore, revisioni o migrazioni retrocompatibili.
- Il prodotto resta locale, con quota e execution separati per provider.
- Il routing cross-provider e il fallback restano opt-in; non si cerca di consumare il 100% della quota a ogni costo.

## 0. Chiudere il rename

1. Eseguire full CI su `main` e rendere obbligatori i job CI nel ruleset/protezione.
2. Rinominare il repository GitHub in `damn-fine-pizza/llm-squeeze` mantenendo la fork network.
3. Aggiornare `origin` locale verso il nuovo slug.
4. Pubblicare e revisionare il branch `feat/llm-squeeze-phase-0`.
5. Mergiare il branch dopo CI verde: package, CLI, `~/.llm-squeeze`, `LLM_SQUEEZE_HOME`, servizi, plugin, MCP e dashboard devono usare solo il nuovo nome.
6. Verificare clone, install, `llm-squeeze version`, `doctor`, MCP HTTP e updater dal nuovo repository.
7. Eliminare i branch remoti già mergiati (#10, #11, #12) quando non servono più come riferimento operativo.

## 1. Consolidare il core provider

Il registry locale già separa `BudgetSource` e `ExecutionBackend` per Claude. Il prossimo passo è renderlo la sola porta d'accesso del runtime.

1. Spostare tutti i consumer diretti di `providers["claude"]` dietro query per provider/profilo.
2. Rendere `latest.json` una cache per profilo con stato `healthy`, `stale`, `unavailable` e timestamp indipendenti.
3. Generalizzare le finestre budget: nome, unità, valore, reset, sorgente e affidabilità; non assumere soltanto 5h/weekly.
4. Conservare Claude come primo profilo `claude-default` e coprire il contratto con fixture.
5. Non aggiungere ancora un adapter Codex in produzione prima dello spike telemetrico.

## 2. Workspace task e batch

1. Aggiungere titolo Markdown, provider/profilo/modello preferiti, categoria, ordine manuale e stato di pausa al task.
2. Esporre CRUD dashboard e MCP per task, inclusa modifica del prompt già disponibile da #12.
3. Implementare ordine manuale e modalità esplicite `manual` / `priority`.
4. Introdurre `preview_batch` e `run_queue`: la preview e l'esecuzione devono usare lo stesso planner puro.
5. Registrare per ogni scelta una receipt: task, provider, profilo, stima, policy, reason code e snapshot budget.
6. Mantenere delete permanente come azione esplicita; non aggiungere archive o revisioni finché non diventano un requisito reale.

## 3. Scheduler e token efficiency

1. Rendere il planner deterministico: nessuna turn LLM per decidere eligibility, ordine, retry o cutoff.
2. Applicare safety margin prima del reset; il cutoff blocca nuovi start, non interrompe automaticamente un run attivo.
3. Aggiungere manual reserve/preemption tramite override esplicito, non inferenze fragili sulle sessioni utente.
4. Introdurre modalità di pacing `protect`, `balanced`, `flush` solo per provider con telemetria affidabile e policy opt-in.
5. Implementare preflight senza modello: repository/cwd, autorizzazioni, worktree, dipendenze e duplicati.
6. Ridurre output ripetitivo con un `OutputReducer` deterministico; preservare sempre exit code, conteggi e raw artifact soggetto a retention.
7. Misurare token, retry amplification, durata, acceptance/test pass rate e cache quando osservabile; ottimizzare lavoro utile, non il solo volume di token.

## 4. Timer, routing e interfacce

1. Aggiungere timer persistenti per timestamp e cron, con create/update/pause/cancel/list.
2. Definire categorie task configurabili e matrici provider/profilo ordinate.
3. Consentire fallback soltanto se esplicitamente abilitato e senza ampliare permessi, sandbox o tool.
4. Aggiungere CLI: `schedule list`, `schedule add`, `override on|off`, `queue preview`, `queue run`.
5. Esporre gli equivalenti MCP: stato scheduler, policy routing, timer e override manuale.
6. Evolvere la dashboard con card per provider, timeline reset, pacing, backlog, batch e timer. Non sommare percentuali di provider differenti.
7. Non accettare codice TypeScript arbitrario o hot-reload di tool via MCP: i plugin devono essere file locali installati e revisionati dall'utente.

## 5. Codex e altri provider

1. Eseguire uno spike documentato per Codex: `codex exec --json`, capacità reali, qualità/freschezza dei dati e fixture redatte.
2. Se l'esecuzione è stabile, aggiungere prima il backend Codex manual-only e con sandbox/approval espliciti.
3. Aggiungere budget Codex al routing automatico soltanto con una fonte supportata e machine-readable.
4. Valutare Gemini, Z.AI o altri provider solo dopo che il contratto registry ha dimostrato di coprire Codex senza eccezioni ad hoc.
5. `--yolo` non entra mai in `auto` o fallback; richiede un profilo esplicito e ambiente esterno isolato.

## Criteri prima della prima release multi-provider

- Un task può essere creato, modificato, riordinato, cancellato o eseguito dalla dashboard e da MCP.
- Batch preview, run e stop producono decisioni spiegabili e riproducibili.
- Claude e Codex hanno backend distinti e un run conserva provider/profilo/modello effettivi.
- Le card budget distinguono observed, estimated, stale e unavailable.
- Il routing non confronta o somma percentuali incompatibili.
- Le policy di risparmio token non riducono test pass rate o aumentano retry/rework.
- Tutti i comandi e runtime pubblici usano esclusivamente `llm-squeeze`.
