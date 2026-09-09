# LLM Squeeze: evoluzione verso uno scheduler locale multi-provider

Stato: piano rivisto; Fase 0 avviata sul branch dedicato `feat/llm-squeeze-phase-0`

Data di revisione: 2026-09-09

Ambito: prodotto, architettura, migrazione, sicurezza, test e rollout

Vincolo: nessuna dipendenza da servizi cloud propri; dati e orchestrazione restano locali

### Avanzamento implementazione

- **Completato localmente:** clean rename a `llm-squeeze` per package, CLI, runtime home, variabile ambiente, servizi, plugin, MCP, dashboard, documentazione e test.
- **Completato localmente:** guardia automatica contro la reintroduzione del branding sostituito e CI con concorrenza/timeout espliciti.
- **Completato localmente:** primo registry provider con `BudgetSource` ed `ExecutionBackend` separati, entrambi usati dai percorsi Claude reali.
- **In attesa del rename gate remoto:** protezione `main`, rename GitHub e aggiornamento di `origin`; le PR #10, #11 e #12 sono già in `main`.
- **Non ancora iniziato:** schema task/run v2, backend Codex, batch planner e dashboard multi-provider.

## 1. Sintesi esecutiva

Il prodotto deve evolvere da tracker e scheduler Claude-specifico a un workspace locale per attività eseguite da agenti diversi. La direzione è valida, ma il passaggio non va trattato come l'aggiunta di una pagina Codex o di un secondo parser: richiede di separare quattro concetti che oggi coincidono spesso nel codice:

1. il lavoro da svolgere (`Task`);
2. il tentativo concreto di eseguirlo (`Run`);
3. il motore che lo esegue (`ExecutionBackend`);
4. la sorgente che osserva limiti e consumo (`BudgetSource` / `UsageSource`).

La prima release utile non deve promettere ottimizzazione perfetta della quota. Deve offrire un backlog affidabile, esecuzioni tracciabili, policy spiegabili e fail-safe quando la telemetria non è disponibile. L'ottimizzazione multi-provider viene dopo che i dati di quota Codex sono stati verificati con un canale supportato e machine-readable.

La sequenza raccomandata è:

1. riordinare le PR aperte e portare `main` a una baseline verde;
2. rinominare il repository GitHub mantenendo il fork e i redirect;
3. introdurre migrazioni DB e un modello di dominio stabile;
4. completare il workspace task e il CRUD;
5. separare gli adapter di esecuzione e aggiungere Codex dietro feature flag;
6. introdurre batch, preview e registro delle decisioni;
7. generalizzare budget e telemetria per provider/profilo;
8. abilitare routing `auto` e scheduling reset/deadline-aware;
9. completare dashboard aggregata e hardening.

Il default iniziale deve restare prudente: una sola esecuzione globale, fallback disabilitato, task distruttivi solo manuali, dati incerti esclusi dalle decisioni automatiche.

## 2. Review del piano precedente

### 2.1 Cosa resta valido

- La tesi di prodotto è corretta: il valore principale è nel backlog persistente e nell'orchestrazione, non nella sola visualizzazione delle percentuali.
- Markdown è il formato canonico giusto per i prompt: portabile, versionabile e utilizzabile da dashboard, CLI e MCP.
- Le percentuali di provider diversi non devono essere sommate.
- Il fallback tra agenti deve essere esplicito.
- La provenienza, freschezza e qualità dei dati devono essere visibili.
- L'astrazione deve avere contratti a capability e finestre dinamiche, senza impegnare la roadmap su adapter provider non necessari.
- La telemetria Codex va verificata prima di autorizzarla a governare esecuzioni automatiche.

### 2.2 Correzioni necessarie

| Tema | Correzione | Motivo |
|---|---|---|
| Stato attuale | Il progetto possiede già pacing continuo, intenti, deadline, stime adattive e metadati in `task_schedule_meta`. | Non bisogna reimplementarli; vanno migrati nel nuovo modello. |
| Scheduler | “Night executor” non è l'unica logica attuale: esiste anche `paced-executor`, invocato dal poller e limitato a un task per snapshot fresco. | Il nuovo scheduler deve sostituire due percorsi compatibili ma duplicati. |
| Provider | Non creare un'unica interfaccia enorme con fetch, usage, execute e parsing obbligatori. | Esecuzione e osservabilità possono avere disponibilità e cicli di vita diversi. |
| Identità | Separare `provider` da profilo/account/autenticazione. | Due profili Codex o Claude possono avere quote, crediti e policy differenti. |
| Budget | `targetUtilization` è ambiguo. Usare un obiettivo morbido e una soglia dura distinti. | Un valore non può contemporaneamente guidare il pacing e fungere da stop di sicurezza. |
| Reset | Il margine di 60 minuti blocca nuove ammissioni; non interrompe automaticamente un task già avviato. | Uccidere un task al cutoff può sprecare lavoro e quota. |
| Stato task | Pausa e archivio non devono diventare stati alternativi al lifecycle. | Sono attributi ortogonali: un task riuscito può essere archiviato, uno queued può essere in pausa. |
| Ordine | L'ordine manuale e la priorità richiedono una modalità esplicita per coda, non una formula nascosta. | Evita riordinamenti sorprendenti dopo l'autosave o un cambio di priorità. |
| Stime | Token, percentuale di quota, crediti e costo non sono convertibili con un coefficiente universale. | Modello, reasoning, cache, strumenti e superficie cambiano il consumo. |
| Concorrenza | Lock per provider più limite globale non basta. Serve anche una lane esclusiva per repository/cartella scrivibile. | Due agenti sullo stesso working tree possono produrre conflitti anche se usano provider diversi. |
| “Tempo reale” | Per l'MVP è sufficiente polling breve con cursori; SSE può arrivare dopo. | Evita di aggiungere subito un protocollo persistente alla dashboard inline. |
| Editor rich | Markdown + toolbar + preview sanificata, non WYSIWYG. | Riduce dipendenze, perdita di formattazione e superficie XSS. |
| Nome | Eseguire un clean break coordinato: prodotto, package, launcher, directory dati, variabile ambiente, servizi, plugin e MCP assumono insieme l'identità `llm-squeeze`. | Evita alias permanenti e una matrice di nomi che diventerebbe debito tecnico; il cambio è dichiaratamente breaking. |

### 2.3 Riscontri puntuali nel repository

Il piano deve partire dai seguenti fatti verificati nel codice:

- `UsageProvider` espone solo `fetch()` e `allProviders()` registra solo `ClaudeProvider` (`src/types.ts`, `src/providers/index.ts`).
- `WindowKey` è una union fissa Claude e `WINDOW_DURATION_MS` è globale.
- `latest.json` ha una forma apparentemente multi-provider, ma lettori, dashboard, menubar ed executor usano direttamente `providers["claude"]`.
- La freschezza di `latest.json` è globale; non rappresenta correttamente un provider riuscito e uno fallito nello stesso poll.
- Il poller interroga i provider in sequenza e riscrive soltanto quelli riusciti nel file più recente; un errore può far sparire temporaneamente l'ultimo dato noto di un provider.
- `Task` non contiene provider, modello, ordine esplicito, titolo, archivio o versione di modifica.
- `task_schedule_meta` è una sidecar aperta con una seconda connessione SQLite. La creazione task e metadati non è una singola transazione.
- Lo schema viene inizializzato con `CREATE TABLE IF NOT EXISTS`; non esiste un migration runner versionato.
- SQLite non abilita esplicitamente `PRAGMA foreign_keys = ON` in ogni connessione.
- La dashboard offre API di sola lettura e una scrittura per le impostazioni; non ha CRUD task.
- L'MCP crea task e aggiorna solo priorità/intent/deadline/continuous, non prompt, cwd o permessi.
- Runner, parser, argomenti CLI, session resume e lock sono Claude-specifici.
- `resume_session_id` e `worktree_path` sono sul task, anche se appartengono a un tentativo/provider concreto.
- `task_runs` non registra provider, profilo, batch, decisione di ammissione o snapshot completo della configurazione usata.
- `usage_events.message_id` è globalmente unico; in un mondo multi-provider deve essere namespaced.
- Il manual run avverte su snapshot stale ma può procedere, mentre il paced executor fallisce chiuso: la policy va resa uniforme ed esplicita.
- Il lock `scheduler.lock` impone correttamente una singola esecuzione, ma non scala a limiti per profilo/provider/repository.

Questi non sono tutti bug da correggere immediatamente. Sono vincoli di migrazione e punti in cui evitare di aggiungere altro accoppiamento.

### 2.4 Destinazione delle funzionalità esistenti

La trasformazione non deve lasciare ambiguo cosa accade al prodotto attuale. La regola è: conservare il valore e le garanzie, generalizzare ciò che è Claude-specifico, deprecare soltanto le superfici duplicate e rimuovere solo concetti diventati semanticamente falsi.

| Funzionalità attuale | Decisione | Destinazione nel prodotto nuovo | Transizione |
|---|---|---|---|
| Poll `claude -p "/usage"` | **Mantenuta** | `ClaudeBudgetSource`, una delle sorgenti del profilo Claude. | Stesso comportamento dietro adapter e contract test. |
| Snapshot SQLite e storico finestre | **Mantenuti e generalizzati** | Osservazioni budget dinamiche per profilo, sorgente e finestra. | Migrazione atomica dei record nel profilo `claude-default`. |
| `latest.json` | **Reinterpretato** | Cache/proiezione atomica, non fonte canonica; freschezza per profilo. | Tutti i consumer passano alla forma v2 nella stessa release dello schema. |
| Forecast di burn rate/reset | **Mantenuto** | Forecast indipendente per ogni finestra osservabile. | Nessun confronto o somma fra provider; algoritmo versionato. |
| Nudge under-use/over-use | **Mantenuti** | Notifiche namespaced per profilo e finestra. | Chiavi di cooldown migrate da `window` a `profile + window`. |
| Schedule hint | **Generalizzato** | Suggerimento di capacità/opportunità del nuovo scheduler. | Testo e trigger non più Claude/night-specifici. |
| SwiftBar menubar | **Mantenuta come integrazione opzionale** | Glance multi-provider con profilo più urgente e link dashboard. | Comando e label assumono subito il nuovo brand. |
| Ingest dei log Claude Code | **Mantenuto** | `ClaudeUsageSource`; conserva scope “Claude Code locale”. | Event id namespaced e cursori migrati; nessuna falsa copertura di claude.ai. |
| Totali per modello e categorie token | **Mantenuti e generalizzati** | Breakdown per provider/profilo/modello con categorie originali. | I totali globali compaiono solo per unità compatibili. |
| Heatmap contributi | **Mantenuta** | Heatmap con selettore `runs`, durata, token o costo. | La metrica è sempre esplicita; default compatibile sui dati Claude esistenti. |
| Coda task SQLite | **Mantenuta e promossa a core** | Workspace durevole con CRUD, revisioni, archivio e batch. | Migrazione senza perdita dei task correnti. |
| Prompt task | **Mantenuto ed esteso** | Markdown canonico modificabile con revision history. | Il testo esistente diventa revisione 1. |
| Size `xs`–`xl` | **Mantenuta** | Stima iniziale/UX, non misura universale di quota. | Calibrazione per backend/profilo/modello. |
| Stima adattiva | **Mantenuta e generalizzata** | Durata e consumo storico per backend/profilo/modello/classe. | I sample esistenti restano attribuiti a Claude. |
| Priority | **Mantenuta** | Criterio nella modalità `priority`, secondario/visibile in `manual`. | Nessuna modifica silenziosa all'ordine durante la migrazione. |
| Intent `interactive/deadline/opportunistic` | **Mantenuti** | Parte della policy di ammissione provider-neutral. | Metadati sidecar incorporati atomicamente nel dominio v2. |
| Deadline | **Mantenuta e rafforzata** | Slack e latest-safe-start basati su p95 e safety margin. | Il vecchio `deadlineSafetyMinutes` viene migrato. |
| Pause/resume task | **Mantenuti** | `pausedAt` ortogonale allo stato del task. | Gli strumenti MCP correnti restano alias. |
| `continuousOk` | **Reinterpretato** | Opt-in all'esecuzione automatica fuori quiet hours. | Diventa vincolo task dentro availability policy. |
| `deferOk` | **Rimosso dal modello v2** | Ridondante rispetto a intent, availability e manual-only. | Convertito dalla migrazione; nessun doppio percorso runtime. |
| `scheduledWindow: night/any` | **Sostituito** | Availability constraints e policy `always/quiet-hours/deadline-aware/until-reset`. | `night` → quiet-hours; `any` → always se autorizzato. |
| Night window e conferma timezone | **Mantenute come policy opzionale** | Quiet-hours con conferma e timezone esplicite. | Non è più il modello principale, ma le garanzie restano. |
| Lowest-usage night hour | **Mantenuto come euristica opzionale** | Strategia di start dentro quiet-hours quando i dati sono sufficienti. | Non blocca le altre availability policy. |
| Fit del task nel tempo residuo | **Mantenuto e generalizzato** | Check `p95 duration + safety margin` prima del reset/fine availability. | Sostituisce il solo confronto timeout/fine notte. |
| Guard globali session/weekly | **Sostituiti** | Soglie soft/hard per profilo e finestra. | I valori correnti inizializzano la policy Claude predefinita. |
| Pacing lineare/forecast-based | **Mantenuto e generalizzato** | Policy per finestra; forecast preferito, fallback conservativo. | Prima parità Claude, poi altri provider. |
| Retry e `maxAttempts` | **Mantenuti e migliorati** | Retry per classe d'errore, backend e batch con backoff. | `maxAttempts` resta default globale durante la transizione. |
| Stato `carried_over` | **Rimosso dal modello v2** | Task `queued` con retry pendente e ultimo run fallito. | Convertito dalla migrazione copy-and-swap. |
| Permission triage | **Mantenuto e generalizzato** | Authorization profile intersecato con capability backend. | Mapping iniziale dalle tre classi correnti. |
| Destructive manual-only | **Mantenuto come invariante** | Nessun backend/fallback lo rende unattended. | Nessuna deprecazione prevista. |
| Worktree write-scoped | **Mantenuto e migliorato** | Artifact del singolo run, con retention e repository lane. | I path esistenti vengono collegati all'ultimo run noto durante la migrazione. |
| Manual executor | **Mantenuto** | `task run` attraverso scheduler/run service, con override registrato. | Il vecchio entrypoint è sostituito nella stessa release. |
| Night executor | **Assorbito** | Un'unica scheduler loop con availability `quiet-hours`. | L'implementazione duplicata viene eliminata dopo i test di parità. |
| Paced executor one-shot | **Assorbito** | Un'unica scheduler loop con rivalutazione prima di ogni claim. | Timer e daemon vengono aggiornati insieme al nuovo servizio. |
| Lock globale Claude | **Sostituito** | Lock neutro con concorrenza 1 nell'MVP; lease/lane in seguito. | Un solo scheduler viene installato e avviato. |
| Stale-run recovery | **Mantenuta e rafforzata** | Lease, heartbeat, owner token e process-group recovery. | I run preesistenti sono convertiti con campi nullable conservativi. |
| `task_runs` con token/costo/raw | **Mantenuta e normalizzata** | Run provider-specifici, metriche tipizzate e raw redatto come artifact. | Copy-and-swap preserva i dati e rimuove le colonne obsolete. |
| Session id Claude | **Mantenuto ma spostato** | Campo provider-specifico del run; resume policy esplicita. | Il valore sul task è letto solo per migrazione. |
| CLI status/tasks/hint/enqueue | **Mantenuta** | Comandi provider-neutral sotto il solo binario `llm-squeeze`. | Nessun alias di branding. |
| MCP stdio | **Mantenuto** | Stessi tool più campi/addizioni compatibili. | Il server usa subito l'identità `llm-squeeze`. |
| MCP Streamable HTTP | **Mantenuto** | Trasporto condiviso dello stesso service layer. | Endpoint e sicurezza loopback restano; l'identità cambia in modo coordinato. |
| Dashboard locale | **Mantenuta e ampliata** | Home multi-provider + task workspace + batch/run history. | Nessun server remoto obbligatorio. |
| Settings e autosave impostazioni | **Mantenuti** | Config versionata per scheduler e profili. | Import automatico della config corrente. |
| Auto-open dashboard | **Mantenuto** | Preferenza neutra del prodotto. | Nessun cambio comportamentale. |
| `version`, `doctor`, `update` | **Mantenuti e ampliati** | Diagnostica profili/provider e update dal repository rinominato. | Riconoscono soltanto l'identità nuova. |
| `install` / `uninstall` | **Mantenuti** | Installazione neutra sotto `~/.llm-squeeze`. | Uninstall continua a preservare i dati nuovi. |
| launchd, systemd user timer e daemon | **Mantenuti** | Scheduler cross-platform con unit `llm-squeeze`. | Una sola famiglia di unità nel codice. |
| Plugin Claude Code | **Mantenuto come integrazione Claude** | Plugin/provider integration separato dal core multi-provider. | Plugin e skill assumono subito il nome `llm-squeeze`. |
| Inglese come lingua UI | **Mantenuto** | Lingua base; i18n resta possibile ma fuori MVP. | Nessun ritorno a stringhe provider-specifiche. |
| Local-first/no telemetry propria | **Mantenuto come principio** | DB, dashboard e orchestrazione locali. | Nuove sorgenti dichiarano chiaramente eventuali chiamate ai provider. |
| Dashboard senza CDN | **Mantenuta** | Asset compilati e serviti localmente. | Modularizzare non significa introdurre dipendenze runtime remote. |
| “Zero runtime dependencies” originale | **Già superato** | Minimizzare dipendenze e mantenerle verificabili; MCP SDK resta. | Non ripristinare un obiettivo ormai falso. |

In sintesi, nessuna feature utente importante sparisce. Vengono rimossi i concetti interni ridondanti o fuorvianti (`deferOk`, `carried_over`, `night` come modello centrale) e ogni alias del brand precedente; le capacità utili sopravvivono in forme più generali. Gli executor confluiscono in un solo scheduler, senza implementazioni parallele permanenti.

### 2.5 Stato remoto di branch e pull request

Fotografia verificata il 2026-09-09 tramite API pubblica GitHub. `origin` punta ancora allo slug pre-rename; il repository è pubblico e appartiene a una fork network. Il default branch è `main` e nessuno dei quattro branch remoti risulta protetto. L'endpoint storico dei commit status è vuoto, ma il dato corretto è nei check-run: ciascuna PR ha tre job GitHub Actions conclusi con successo (Ubuntu/Node 22, Ubuntu/Node 24, macOS/Node 22). “Clean” sotto indica la mergeability calcolata da GitHub; “CI verde” indica invece quei check-run.

| Branch / PR | Stato | Decisione | Azione raccomandata |
|---|---|---|---|
| `main` (`ac6c6db`) | Default, non protetto | **Tenere** | Portarlo a baseline verde con l'ordine sotto; poi aggiungere ruleset/check richiesti prima della roadmap v2. |
| `#10` `fix/usage-reset-parsing-and-dashboard` (`cb18210`) | **Merged** 2026-09-09, commit `5957987` | **Mantenere** | Parsing `/usage` e piano display-only sono ora in `main`. |
| `#11` `feat/forecast-based-pacing` (`b8c93e7`) | **Merged** 2026-09-09, commit `f38eb66` | **Mantenere** | Era stacked su #10, è stata retargettata su `main`, verificata e mergiata. |
| `#12` `feat/delete-task` (`035f16d`) | **Merged** 2026-09-09, commit `3290a04` | **Mantenere** | Scelta esplicita: delete permanente di task e `task_runs`, senza archive, revisioni o migration. Gli edit di contenuto e il re-triage restano inclusi. |

Le PR #1–#9 risultano già chiuse e mergiate; i relativi head branch non sono più presenti sul remote. Non c'è altro da cancellare. Sequenza operativa:

1. #10, #11 e #12 sono mergiate in `main`;
2. full test su `main`, scelta dei job richiesti e protezione/ruleset;
3. rename GitHub del repository;
4. eliminazione opzionale dei branch remoti delle PR già mergiate.

Verifica locale della fotografia corrente:

- pila #10+#11: typecheck riuscito; 195 test non-network riusciti e 10/10 test MCP HTTP riusciti con bind loopback consentito, totale 205;
- #12, eseguita da archive isolato: typecheck riuscito; 192 test non-network e 12/12 MCP HTTP riusciti, totale 204;
- il primo fallimento dei test HTTP nel sandbox era esclusivamente `listen EPERM 127.0.0.1`, confermato dal rerun autorizzato; non è una regressione applicativa.

### 2.6 Fork, identità pubblica e rename GitHub

Decisione consigliata: **presentare il progetto come fork avanzato/evoluzione indipendente dell'originale e mantenere per ora il legame di fork GitHub**.

Motivi:

- il prodotto condivide ancora codice, storia e architettura con l'originale;
- la rete di fork rende trasparente la provenienza e permette di confrontare o importare fix upstream;
- il repository contiene già issue/PR e relativa discussione tecnica da non perdere;
- staccare il fork non offre alcun vantaggio necessario per rinominare o sviluppare una direzione diversa.

Il README pubblico deve dichiarare senza ambiguità che LLM Squeeze è un fork in evoluzione indipendente. Conservare storia Git, fork network, licenza, copyright e attribuzione applicabili; il nuovo nome non trasforma retroattivamente la provenienza del codice.

GitHub consente di rinominare il repository mantenendo redirect per pagine e operazioni Git, anche se raccomanda di aggiornare i remote locali. Il detach, invece, è permanente e può perdere issue, PR, wiki, star, watcher e altri metadati. Per questo:

- **ora:** rinominare il fork, non staccarlo;
- **dopo una release multi-provider stabile:** rivalutare il detach solo se il progetto non intende più sincronizzare alcuna fix upstream, l'identità separata porta un beneficio concreto e si accetta esplicitamente la perdita/migrazione dei metadati;
- **mai:** cancellare e ricreare il repository senza un backup verificato e una migrazione deliberata.

Fonti operative: [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository), [Detaching a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork).

## 3. Evidenze esterne e implicazioni

Le regole commerciali cambiano; il codice non deve codificarle come enum o durate immutabili. Le seguenti evidenze sono un riferimento datato, non un contratto perpetuo.

### Codex

La documentazione OpenAI corrente indica che:

- `/status` mostra configurazione, approval policy, writable roots e uso del contesto della sessione; `/usage` espone le viste account disponibili (`daily`, `weekly`, `cumulative`) quando l'autenticazione lo consente;
- Codex, ChatGPT Work e altre superfici agentiche supportate possono condividere allowance e crediti;
- il consumo dipende da modello, luogo di esecuzione, complessità, contesto, reasoning, velocità e strumenti;
- esistono account con finestre di 5 ore e settimanali, ma opzioni e limiti variano per piano e possono essere resettati o acquistati.

Fonti ufficiali: [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540), [Using Credits for Flexible Usage](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-free-go-plus-pro-sora), [How banked Codex resets work](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work).

Nel sistema locale esaminato, Codex CLI 0.153.4 offre `codex exec --json`, selezione di modello/profilo, sandbox, approval policy e working directory. L'help non espone un sottocomando non interattivo `status`. Di conseguenza:

- `codex exec --json` è un candidato concreto per l'execution adapter;
- né `/usage` né `/status` vanno assunti come API automatizzabili soltanto perché esistono nel TUI;
- scraping del TUI o endpoint privati non deve entrare nel percorso stabile;
- l'app-server sperimentale può essere esplorato nello spike, ma non è un contratto finché schema e compatibilità non sono documentati/supportati.

Per l'automazione Codex, i nomi correnti hanno semantiche diverse:

- `codex exec` è il percorso non interattivo per script e CI;
- `--sandbox workspace-write --ask-for-approval never` consente un run hands-off ma confinato al workspace autorizzato;
- `--full-auto` è mantenuto solo come flag di compatibilità deprecato; i nuovi script devono usare la sandbox esplicita;
- `--dangerously-bypass-approvals-and-sandbox`, alias `--yolo`, elimina entrambi i confini ed è previsto solo dentro un ambiente esterno hardened/isolato;
- l'eventuale Auto-review mantiene la sandbox e demanda richieste eleggibili a un reviewer agent: non equivale a `yolo`.

Fonti ufficiali OpenAI: [Command line options](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security).

### Claude

Anthropic documenta che il consumo può essere condiviso tra Claude e Claude Code per i piani in abbonamento, dipende da conversazione, modello e funzionalità, e che esistono finestre di sessione di cinque ore oltre a limiti ulteriori che possono variare. Le modalità API a consumo sono semanticamente diverse dall'abbonamento.

Fonti ufficiali: [How do usage and length limits work?](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work), [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [What is the Pro plan?](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan).

### Conseguenza architetturale

Il sistema deve modellare ciò che osserva, non ciò che presume. Una finestra deve portare nome, unità, direzione, sorgente, timestamp e qualità. “5h” e “weekly” sono dati restituiti da un profilo, non colonne fisse richieste a ogni provider.

### Spunti architetturali e funzionali da progetti affini

Questa non è una classifica dei progetti esaminati. Sono decisioni applicabili a LLM Squeeze ricavate dalle loro architetture e feature, da validare poi con i nostri invarianti e test.

| Spunto | Applicazione in LLM Squeeze | Vincolo |
|---|---|---|
| Scheduler deterministico separato dagli agenti, come motivato da [Bernstein](https://github.com/sipyourdrink-ltd/bernstein/blob/main/docs/architecture/WHY_DETERMINISTIC.md) | Il control loop calcola eligibility, ordine, lane, cutoff e retry con codice e stato persistente; non usa una turn LLM per decidere cosa avviare. | Gli agenti eseguono il lavoro, ma non sono la fonte autoritativa dello stato dello scheduler. |
| Preview, ricevute e provenance presenti in [ebb-ai](https://github.com/Vitalini/ebb-ai) | `preview_batch` usa lo stesso planner di `execute`; ogni decisione produce input snapshot, reason code, timestamp, policy e sorgenti budget. Stop/cancel sono idempotenti. | Nessuna preview “simile” ma implementata con logica separata da quella reale. |
| Pipeline deterministiche di riduzione del rumore ispirate a [gsqz](https://github.com/gobbyai/gsqz) | Compattare log ripetitivi, output di test e discovery prima di reinserirli nel contesto; mostrare byte/token stimati risparmiati. | Conservare exit code, conteggi e artifact raw con retention; non trasformare un errore in successo e non inventare output. |
| Discovery e viste delle finestre separate viste nei tracker locali multi-provider, inclusa [llm-quota](https://github.com/SandroHub013/llm-quota) | Registry di profili e sorgenti, card indipendenti, timeline reset e stato `unavailable/stale` per singola finestra. | La discovery propone configurazione: non acquisisce credenziali né abilita esecuzioni automaticamente. |

Decisioni conseguenti da aggiungere al backlog:

- un solo `Planner` puro condiviso da preview ed execute;
- receipt append-only per batch item e run, con reason code tipizzati;
- `OutputReducer` opzionale, deterministico e specifico per formato/versione;
- artifact raw separato dal sommario compatto, con hash e limiti di retention;
- dry-run end-to-end che non acquisisce lease, non crea worktree e non avvia provider;
- discovery provider esplicita con stato `detected`, `configured`, `healthy`, senza auto-enrollment.

## 4. Obiettivo di prodotto e confini

### Obiettivo

Massimizzare il lavoro utile completato entro vincoli di tempo, autorizzazione e capacità, fornendo sempre una spiegazione riproducibile delle decisioni.

Il prodotto è un control plane locale solo nel senso di coordinamento sul computer dell'utente. Non deve suggerire, nella prima release, controllo centralizzato, multi-utente o garanzie di quota che le piattaforme non offrono.

### MVP

L'MVP multi-provider deve consentire di:

- creare, modificare, duplicare, archiviare, mettere in pausa e riordinare task;
- conservare il prompt in Markdown con revisioni recuperabili;
- scegliere `claude`, `codex` o `auto`, con modello/profilo opzionali;
- eseguire Claude e Codex attraverso backend distinti;
- effettuare preview e avvio di un batch;
- vedere task ammessi, esclusi, saltati e relativa motivazione;
- mostrare card budget separate con provenienza e freschezza;
- fermare nuove ammissioni prima del reset secondo policy;
- preservare i dati utili tramite migrazioni atomiche, usando un'unica identità runtime.

### Non-obiettivi dell'MVP

- saturare automaticamente ogni quota;
- convertire token in percentuale di subscription;
- usare API private o fare scraping fragile delle UI;
- distribuire lavoro su più macchine;
- supportare collaborazione multi-utente;
- eseguire task distruttivi senza presenza e conferma umana;
- fare merge automatico dei worktree nel branch dell'utente;
- mantenere alias di branding o doppi percorsi runtime dopo il clean break.

### Naming: decisione definitiva e dieci alternative valutate

“Plan Ahead” descrive un comportamento generico, non rende riconoscibili coda, finestre, capacità o agenti, ed è difficile da cercare come nome di prodotto. È inoltre ambiguo come slug (`plan-ahead`, `planahead`) e suona più come planner personale che come orchestratore locale.

Decisione definitiva:

- **nome prodotto:** LLM Squeeze;
- **repository GitHub:** `damn-fine-pizza/llm-squeeze`;
- **binario canonico:** `llm-squeeze`;
- **payoff:** “Squeeze more useful work from your AI quotas”;
- **descrizione esplicativa:** “Local quota-aware backlog and scheduler for coding agents”.

“Squeeze” comunica l'uso efficiente di quota, tempo e contesto ed è più riconoscibile dei nomi puramente descrittivi. Non deve però tradursi in “consumare il 100% a ogni costo”: margine di reset, hard stop, quality floor e riserva restano invarianti. La documentazione deve chiarire che il prodotto non comprime o quantizza modelli; ottimizza l'ammissione e l'esecuzione del lavoro.

Lo screening web leggero non ha trovato un repository esatto dominante chiamato `llm-squeeze`, ma “squeeze” è usato nell'ecosistema per compressione di output, prompt e modelli. Questo non blocca la scelta, purché tagline, topic e README mettano subito in evidenza **quota-aware task scheduling**. La clearance completa resta un gate pre-release, non una riapertura implicita del naming.

Dieci alternative valutate e non scelte, comunque più informative di “Plan Ahead”:

| # | Nome | Slug suggerito | Perché è più adatto | Limite |
|---:|---|---|---|---|
| 1 | **LLM Quota Scheduler** | `llm-quota-scheduler` | Mantiene le keyword più importanti e dichiara il differenziatore operativo rispetto ai tracker puri. | “LLM” può invecchiare e il nome è descrittivo, non distintivo. |
| 2 | **Agent Capacity** | `agent-capacity` | Più vicino alle coding agent reali che al concetto generale di LLM. | Non comunica esplicitamente la coda. |
| 3 | **QueueSpan** | `queuespan` | Unisce coda e arco temporale/capacità; è corto e provider-neutral. | “Span” può ricordare il tracing. |
| 4 | **Quota Queue** | `quota-queue` | Molto diretto: budget e backlog nello stesso nome. | Generico e poco differenziabile. |
| 5 | **Forequeue** | `forequeue` | Fusione di forecast + queue, aderente alla pianificazione anticipata. | Pronuncia non immediata. |
| 6 | **Agent Cadence** | `agent-cadence` | Comunica il ritmo sostenibile di più agenti. | Non nomina quota o backlog. |
| 7 | **Reset Lane** | `reset-lane` | Richiama finestre di reset e lane di esecuzione. | Enfatizza il reset più del workspace. |
| 8 | **Task Reserve** | `task-reserve` | Evoca capacità riservata e ammissione prudente. | Può sembrare una funzione di prenotazione. |
| 9 | **Queue Margin** | `queue-margin` | Rende chiari backlog e headroom. | Suona più analitico che operativo. |
| 10 | **SpareCycle** | `sparecycle` | Comunica l'uso del budget inutilizzato per lavoro utile. | Può ricordare uno scheduler CPU. |

Il controllo fatto per questa review è soltanto uno screening web leggero, non una verifica legale, di marchio, dominio, npm o GitHub. Prima del rename definitivo bisogna verificare almeno:

- repository e organizzazioni GitHub;
- package npm e nomi dei binari;
- domini desiderati;
- app store/marketplace rilevanti;
- marchi nelle giurisdizioni di interesse;
- handle social, se utili.

Lo screening ha già evidenziato collisioni dirette o molto vicine per il precedente candidato descrittivo, `AgentPace`, `QuotaPilot`, `QueuePilot`, `TaskHarbor`, `TaskTide`, `RunLedger` e nomi basati su “Runway”. Il rename tecnico è un clean break coordinato nella Fase 0: repository, documentazione, package, binario, servizi, plugin, MCP e directory dati cambiano insieme.

`LLM Scheduler` / `llm-scheduler` non è stato scelto: oltre alla collisione diretta con [`KatherLab/LLM-Scheduler`](https://github.com/KatherLab/LLM-Scheduler), il nome è già usato per scheduler di serving GPU e per sistemi in cui un LLM seleziona workflow. Anche il precedente candidato puramente descrittivo aveva una collisione diretta.

## 5. Principi e invarianti

1. **Fail closed nell'automazione.** Un task automatico non parte se mancano autorizzazione, salute del backend o dati richiesti dalla sua policy.
2. **Manuale esplicito.** Un run manuale può procedere con telemetria stale soltanto dopo un override visibile e registrato; le altre protezioni restano attive.
3. **Nessuna falsa equivalenza.** Percentuali, token, crediti, valuta e request rate restano misure distinte.
4. **Fallback senza escalation.** Cambiare provider non può aumentare filesystem, rete, tool o approval policy.
5. **Snapshot immutabile del run.** Ogni tentativo conserva prompt, provider, modello, profilo, policy, stima e decisione usati in quel momento.
6. **Una decisione, una ragione.** Ogni ammissione o esclusione produce un codice macchina e una spiegazione leggibile.
7. **At-most-once claim, retry esplicito.** Un task non viene eseguito due volte per una race; ogni retry crea un nuovo run.
8. **Resume confinato.** Un session id può essere riusato solo dallo stesso backend/profilo e mai dopo fallback implicito.
9. **Scritture isolate.** Due run write-scoped sullo stesso repository non partono contemporaneamente per default.
10. **Cutoff di ammissione.** `resetSafetyMinutes` impedisce nuovi start dopo il cutoff; non termina un run già in corso salvo policy di cancellazione separata.
11. **Compatibilità reversibile.** Ogni fase legge i dati precedenti e può essere disattivata senza perdere la coda.
12. **Locale non significa fidato.** Dashboard e Markdown devono resistere a CSRF, DNS rebinding e contenuto non sicuro.
13. **Efficienza corretta per qualità.** Ridurre token o costo non è un successo se aumentano retry, difetti o lavoro umano di revisione.

## 6. Modello concettuale

### 6.1 Identità del provider

Usare tre livelli distinti:

- `providerId`: famiglia del prodotto, inizialmente `claude` o `codex`;
- `profileId`: account/configurazione/autenticazione locale, per esempio `codex-personal`;
- `backendId`: implementazione di esecuzione, per esempio `codex-cli` o `claude-cli`.

Il task può puntare a:

- un provider fisso;
- un profilo fisso;
- `auto`, con un insieme di profili ammessi.

Il profilo contiene riferimenti a configurazione locale, mai token o segreti copiati nel DB. I segreti restano nei credential store dei client o in variabili d'ambiente autorizzate.

### 6.2 Contratti separati

```ts
interface ExecutionBackend {
  id: string;
  providerId: string;
  capabilities(profile: ProviderProfile): Promise<CapabilitySet>;
  healthCheck(profile: ProviderProfile): Promise<HealthResult>;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  cancel(handle: ExecutionHandle): Promise<void>;
  parse(events: AsyncIterable<unknown>): Promise<NormalizedRunResult>;
}

interface BudgetSource {
  id: string;
  providerId: string;
  fetch(profile: ProviderProfile): Promise<BudgetObservation>;
}

interface UsageSource {
  id: string;
  providerId: string;
  read(cursor: UsageCursor): Promise<UsagePage>;
}
```

Un profilo può avere un `ExecutionBackend` senza `BudgetSource`. In tal caso può essere usato manualmente, oppure automaticamente solo con una policy che non richiede una quota subscription osservabile, per esempio un budget API configurato.

### 6.3 Budget normalizzato

Ogni osservazione deve includere:

- `profileId`, `providerId`, `sourceId`;
- `capturedAt`, `observedAt`, `validUntil` opzionale;
- `sourceKind`: `official-api`, `official-cli`, `documented-local`, `manual`, `estimated`;
- `quality`: `observed`, `estimated`, `stale`, `unavailable`, `error`;
- `rawPayload` preservato con limiti di dimensione e redazione;
- una lista dinamica di finestre.

Ogni finestra deve includere:

- `key` e label restituite dalla sorgente;
- `kind`: `included-allowance`, `credits`, `spend`, `rate-limit`;
- `unit`: `percent`, `credits`, `usd`, `tokens`, `requests` o unità provider-specifica;
- `used`, `remaining`, `limit` quando disponibili;
- `utilizationPct` solo se derivabile senza ambiguità;
- `startsAt`, `resetsAt` o `periodMs` quando disponibili;
- `scope`, per esempio modelli/superfici comprese;
- `confidence` e `notes`.

`WindowKey` diventa una stringa validata e namespaced, non una union globale. Le durate non devono essere ricostruite dal nome.

### 6.4 Task, run e batch

**Task** descrive l'intento durevole:

- titolo;
- prompt Markdown canonico;
- cwd/repository;
- size e stime opzionali;
- provider target, profilo/modello opzionali;
- capability richieste;
- authorization profile;
- fallback policy;
- context policy (`new`, `resume`, `auto`) e sessione sorgente opzionale;
- quality floor, effort e budget di output/costo opzionali;
- intent e deadline;
- posizione manuale;
- pausa, archivio e versione di modifica;
- stato corrente e ultimo risultato sintetico.

**Run** descrive un singolo tentativo immutabile:

- task e batch;
- numero tentativo;
- provider/profilo/backend/modello richiesti ed effettivi;
- snapshot di prompt e policy;
- stato, tempi, PID/handle, heartbeat e causa di terminazione;
- metriche normalizzate e payload grezzo redatto;
- session id provider-specifico;
- token budget richiesto, limite effettivamente applicato e causa di eventuale superamento;
- fingerprint del contesto e statistiche di cache quando il backend le espone;
- worktree e altri artifact;
- risultato sintetico ed errore strutturato.

**Batch** descrive un comando “Run queue”:

- id, creatore (`dashboard`, `mcp`, `cli`, `scheduler`);
- policy e obiettivo temporale congelati;
- modalità `preview` o `execute`;
- task candidati e ordine iniziale;
- stato e motivo di stop;
- contatori e timestamp.

Un task può partecipare a più batch nel tempo. La relazione vive in `batch_items`; non va conservato un solo `batch_id` sul task.

## 7. Stato e ordinamento

### 7.1 Lifecycle

Stati task proposti:

- `draft`: salvato ma non schedulabile;
- `queued`: schedulabile se eleggibile;
- `running`: almeno un run attivo;
- `succeeded`: completato;
- `failed`: tentativi esauriti o errore terminale;
- `canceled`: cancellato esplicitamente.

`pausedAt` e `archivedAt` restano attributi. “Blocked”, “deferred” e “skipped” sono esiti di una decisione o di un batch item, non stati permanenti del task.

Migrazione iniziale:

- `done` → `succeeded` nella proiezione nuova;
- `carried_over` → `queued` con ultimo run fallito e retry pendente;
- la migrazione copy-and-swap converte tutti i valori prima di avviare il nuovo runtime.

Non modificare subito il `CHECK` della tabella `tasks`: prima introdurre una tabella v2 o una migrazione copy-and-swap coperta da fixture di database reali.

### 7.2 Modalità di coda

Supportare due modalità, scelte a livello di vista/batch:

- `manual`: `sort_key`, poi deadline urgente solo se la policy consente preemption, poi id;
- `priority`: deadline/slack, priority, `sort_key`, id.

Per l'MVP usare posizioni intere sparse (`1024`, `2048`, …) e rinumerazione transazionale quando non esiste più spazio. È più semplice da verificare di ranking frazionale e adeguato a una coda locale.

Il reorder API riceve gli id coinvolti e le revisioni attese. Se un task è cambiato nel frattempo restituisce `409 Conflict`, senza sovrascrivere il lavoro dell'utente.

## 8. Persistenza e migrazioni

### 8.1 Migration runner

Prima di evolvere lo schema:

- introdurre `schema_migrations(version, name, applied_at)` oppure usare `PRAGMA user_version` con una tabella di audit;
- eseguire ogni migrazione in `BEGIN IMMEDIATE`;
- abilitare `foreign_keys`, `busy_timeout` e WAL su ogni connessione tramite una factory unica;
- fare backup del DB prima di una migrazione copy-and-swap;
- non usare downgrade distruttivi automatici;
- testare upgrade da DB vuoto e da ogni schema rilasciato noto;
- mantenere idempotente l'apertura concorrente da poller/dashboard/MCP.

La classe `Store` e `SchedulerMetaStore` devono convergere su un unico repository/transaction boundary. La creazione di task, metadati e prima revisione deve essere atomica.

### 8.2 Schema target, introdotto per tranche

Tabelle nuove o evolute:

- `provider_profiles`;
- `tasks` v2;
- `task_revisions`;
- `batches`;
- `batch_items`;
- `task_runs` v2;
- `scheduler_decisions`;
- `budget_observations`;
- `budget_windows`;
- `usage_events` v2;
- `execution_leases` o campi lease/heartbeat sui run;
- `artifacts` opzionale, se i soli campi run diventano insufficienti.

Indici minimi:

- task attivi per stato/pausa/archivio/sort key;
- deadline attive;
- run per task, batch, profilo e stato;
- decisioni per batch/task/timestamp;
- ultimo budget per profilo e finestra;
- usage per profilo/modello/timestamp;
- lease attive e repository lane.

La chiave di dedup degli eventi d'uso diventa almeno `(profile_id, source_id, source_event_id)`. I vecchi eventi Claude vengono migrati nel profilo predefinito `claude-default`.

### 8.3 Versioning e concorrenza

Ogni task ha `revision INTEGER NOT NULL`. `PATCH` usa optimistic concurrency (`If-Match` o `expectedRevision`). Autosave e MCP condividono lo stesso service layer; nessun endpoint scrive direttamente SQL.

Le revisioni del prompt salvano snapshot completi per l'MVP, con retention configurabile. I diff possono essere derivati in lettura; non serve una struttura patch proprietaria.

## 9. API, dashboard e MCP

### 9.1 Service layer condiviso

Creare servizi applicativi indipendenti dal trasporto:

- `TaskService`;
- `BatchService`;
- `SchedulerService`;
- `ProviderRegistry`;
- `BudgetService`;
- `RunService`.

Dashboard HTTP, CLI e MCP validano input e chiamano gli stessi metodi. Questo evita che, come oggi, MCP e dashboard abbiano capacità differenti o regole duplicate.

### 9.2 HTTP API proposta

Task:

- `GET /api/tasks?status=&provider=&archived=&q=`;
- `POST /api/tasks`;
- `GET /api/tasks/:id`;
- `PATCH /api/tasks/:id` con revisione attesa;
- `POST /api/tasks/:id/duplicate`;
- `POST /api/tasks/:id/pause` e `/resume`;
- `POST /api/tasks/:id/archive` e `/restore`;
- `POST /api/tasks/reorder`;
- `GET /api/tasks/:id/revisions`;
- `POST /api/tasks/:id/revisions/:revision/restore`.

Batch e run:

- `POST /api/batches/preview`;
- `POST /api/batches`;
- `GET /api/batches/:id`;
- `POST /api/batches/:id/stop`;
- `GET /api/batches/:id/items?cursor=`;
- `GET /api/runs/:id`;
- `POST /api/runs/:id/cancel` quando supportato.

Provider e budget:

- `GET /api/providers`;
- `GET /api/providers/:profileId/health`;
- `GET /api/budgets/latest`;
- `GET /api/usage?...`;
- `GET /api/scheduler/status`;
- `GET /api/scheduler/decisions?...`.

Gli errori usano una forma comune: `code`, `message`, `details`, `requestId`. Liste e timeline usano cursori, non offset non limitati.

### 9.3 Dashboard

La dashboard resta inizialmente HTML/CSS/JS self-contained, ma va divisa in moduli TypeScript o in file sorgente componibili al build; continuare a crescere un'unica stringa inline renderà rischiose le modifiche.

Viste MVP:

1. **Overview**: salute provider, budget separati, run attivi, backlog e forecast.
2. **Tasks**: tabella/board filtrabile, drag-and-drop, azioni e bulk select.
3. **Task editor**: metadati, textarea Markdown, toolbar, preview, autosave e cronologia.
4. **Batch**: preview, inclusioni/esclusioni, progress e motivo di stop.
5. **Run detail**: output sintetico, metriche, errori, artifact e decisione.
6. **Usage**: breakdown provider/modello e heatmap con selettore di metrica.

L'autosave usa debounce, stato `saving/saved/conflict/error` e non salva un draft vuoto come task queued. In caso di conflitto mostra entrambe le versioni.

Per l'aggiornamento progressivo usare polling a 2–5 secondi sulle viste attive con cursor/ETag. Valutare SSE solo quando il volume o l'esperienza lo richiedono.

La preview Markdown deve:

- fare escape dell'HTML per default;
- usare una allowlist se si introduce un renderer;
- vietare script, event handler, URL pericolosi e HTML raw nell'MVP;
- avere una Content Security Policy restrittiva;
- non caricare librerie da CDN.

### 9.4 MCP e CLI

Evolvere gli strumenti senza duplicare i percorsi di branding:

- mantenere i nomi correnti;
- aggiungere i nuovi campi a `submit_task` con default conservativi;
- ampliare `update_task` o introdurre `patch_task` con `expected_revision`;
- aggiungere `duplicate_task`, `archive_task`, `reorder_tasks`;
- aggiungere `preview_batch`, `run_queue`, `get_batch`, `stop_batch`;
- rendere `get_quota_status` multi-profilo e aggiornare insieme tutti i client inclusi nel repository;
- aggiungere `explain_task` / `list_scheduler_decisions`.

CLI canonica proposta:

```text
llm-squeeze task create|edit|list|show|pause|resume|archive|duplicate
llm-squeeze queue reorder|preview|run
llm-squeeze batch show|stop
llm-squeeze provider list|doctor
llm-squeeze budget status
```

`llm-squeeze` è l'unico launcher. Nella stessa release del rename GitHub cambiano anche package, `LLM_SQUEEZE_HOME`, `~/.llm-squeeze`, unità systemd/launchd, plugin e identità MCP. Non vengono installati shim o alias; l'eventuale import dei dati esistenti è un comando one-shot esplicito, verificabile e rimuovibile prima della release stabile.

## 10. Execution adapter e sicurezza

### 10.1 Claude

Il primo adapter nuovo deve avvolgere il comportamento esistente senza cambiarlo:

- `claude -p ... --output-format json`;
- allowlist read-only corrente;
- worktree per `write-scoped`;
- parser attuale e fixture reali;
- timeout, session id e metriche normalizzate.

Il codice corrente salva `resume_session_id`, ma non lo passa al runner: non va quindi considerato resume già implementato. L'estrazione dell'adapter deve prima rendere esplicita la policy `new/resume/auto` e coprirla con test. Le opzioni disponibili dipendono dalla versione del client; il registry di capability, non il codice generico, decide se usare resume, autocompact, modello, effort, output schema o limiti di costo.

Solo dopo i contract test si rimuovono `runClaudeTask`, `buildClaudeArgs` e `parseResultJson` dal percorso comune.

### 10.2 Codex

Il backend candidato usa `codex exec --json` con argomenti passati tramite `execFile`/`spawn`, mai shell interpolation. Mappatura iniziale:

- cwd → `-C`;
- modello → `-m`;
- profilo → `-p`;
- read-only → `--sandbox read-only --ask-for-approval never`;
- write-scoped unattended → worktree dedicato + `--sandbox workspace-write --ask-for-approval never`;
- write-scoped supervisionato → worktree + `--sandbox workspace-write --ask-for-approval on-request`;
- destructive → solo manuale; lo scheduler non aggiunge mai automaticamente `--sandbox danger-full-access`, `--yolo` o flag equivalenti.

Profili Codex predefiniti:

| Profilo | Sandbox/approval effettivi | Unattended | Uso |
|---|---|---:|---|
| `codex-read-only` | `read-only` + `never` | Sì | Analisi, review e report senza scritture. |
| `codex-workspace-auto` | `workspace-write` + `never` | Sì | Modifiche in worktree isolato, rete negata salvo capability esplicita. È il default automatico write-scoped. |
| `codex-workspace-review` | `workspace-write` + `on-request` | No | Run interattivi che possono fermarsi per approvazione. |
| `codex-isolated-yolo` | bypass di approval e sandbox Codex | Solo con runner esterno attestato | Profilo avanzato, disabilitato per default, mai selezionato da `auto` o fallback. |

`codex-isolated-yolo` richiede un isolation provider esterno dichiarato (container/VM effimero), workspace montato col minimo privilegio, segreti minimali, rete deny-by-default/allowlist, limiti di processo/tempo/disco e artifact export controllato. Il solo worktree Git non è isolamento sufficiente. Se il runner non può attestare queste condizioni, il task è `ineligible`. L'abilitazione è configurazione amministrativa separata dall'assegnazione del task e ogni run registra l'override.

La mappatura va verificata con test di capacità sulla versione installata. Se una capability non è supportata, il task è `ineligible`, non viene degradato silenziosamente.

Il parser Codex deve consumare JSONL incrementalmente, conservare eventi sconosciuti entro un limite, identificare risultato finale, token/costo quando presenti e distinguere errore CLI, errore agente, timeout e cancellazione.

Quando supportato, usare output strutturato per il risultato sintetico e richiedere dettaglio aggiuntivo solo on demand. Il raw stream resta un artifact del run e non viene reinviato automaticamente a un nuovo agente.

### 10.3 Authorization profile

Sostituire gradualmente `permissionClass + permissionMode + unattendedOk` con un profilo normalizzato:

- filesystem scope;
- network policy;
- approval policy;
- tool/capability allowlist;
- unattended eligibility;
- worktree required;
- destructive flag;
- directory aggiuntive consentite.

Il profilo distingue sempre due assi: **autonomia** (se può procedere senza una persona) e **contenimento** (filesystem, rete, processi, segreti). “Auto” non significa “full access” e `yolo` non è un sinonimo accettabile di unattended.

La policy effettiva è l'intersezione tra richiesta del task, profilo configurato e capacità del backend. Un fallback può solo mantenerla o restringerla.

### 10.4 Worktree e artifact

Il worktree appartiene al run. Al termine:

- non fare merge automatico;
- mostrare path, commit/diff e istruzioni di review;
- applicare una retention configurabile;
- rimuovere automaticamente soltanto worktree puliti e scaduti, con audit;
- non cancellare worktree con modifiche non committate.

## 11. Batch e scheduler

### 11.1 “Run queue”

L'operazione ha due passi:

1. **Preview**: valuta una fotografia della coda e restituisce ordine, provider proposto, stima, vincoli ed esclusioni.
2. **Execute**: crea il batch, rivaluta i vincoli immediatamente prima di ogni claim e registra eventuali differenze dalla preview.

Lo snapshot iniziale non autorizza l'intero batch: quota, salute, deadline e concorrenza possono cambiare.

`stop_batch` impedisce nuove ammissioni. La cancellazione dei run attivi è un'opzione separata e richiede conferma.

### 11.2 Pipeline decisionale

Per ogni task:

1. verificare stato, pausa, archivio, deadline e dipendenze future;
2. calcolare i profili candidati da target e fallback policy;
3. filtrare per salute e capability;
4. applicare autorizzazione e unattended policy;
5. verificare lane globale/provider/profilo/repository;
6. controllare freschezza e policy budget per ogni finestra vincolante;
7. verificare che `p95Duration + resetSafetyMinutes` rientri prima del reset;
8. calcolare rischio e punteggio;
9. scegliere profilo e modello;
10. acquisire lease/claim atomico;
11. ricontrollare i vincoli immediatamente prima dello spawn.

I filtri sono hard gates; lo scoring non può scavalcarli.

### 11.3 Scoring spiegabile

Usare inizialmente un ordinamento lessicografico, più facile da spiegare di una formula opaca:

1. deadline slack più basso;
2. ordine manuale oppure priorità secondo `queueMode`;
3. task che rientra con maggiore confidenza nel tempo disponibile;
4. affinità con provider preferito;
5. maggiore headroom comparabile all'interno dello stesso profilo;
6. età del task.

Non confrontare direttamente “Claude 40%” con “Codex 40%” come capacità assoluta. Per `auto`, il confronto può usare categorie (`healthy`, `near-limit`, `blocked`) e stime storiche specifiche del profilo; se non c'è evidenza sufficiente si usa la preferenza configurata o si rimanda.

### 11.4 Decision log

Ogni decisione salva:

- `decisionCode`, per esempio `ADMITTED`, `PAUSED`, `STALE_BUDGET`, `NO_CAPABILITY`, `RESET_CUTOFF`, `REPO_BUSY`, `FALLBACK_DISABLED`, `HARD_LIMIT`;
- task, batch, profilo candidato e scelto;
- timestamp e versione policy;
- input rilevanti, inclusi id delle osservazioni budget;
- stima e livello di confidenza;
- spiegazione leggibile;
- durata della validità della decisione.

Evitare di salvare prompt o segreti duplicati nel log decisionale.

### 11.5 Configurazione budget

Configurazione per profilo e finestra:

- `softTargetUtilizationPct`;
- `hardStopUtilizationPct`;
- `admissionCutoffMinutesBeforeReset`, default 60;
- `staleAfterMinutes`;
- `uncertaintyPolicy`: `hold`, `manual-only`, `ignore-for-api-budget`;
- `forecastEnabled`;
- `minSamplesForForecast`;
- eventuale `spendCap` con valuta.

Configurazione scheduler:

- `availabilityMode`: `always`, `quiet-hours`, `deadline-aware`, `until-reset`;
- `queueMode`: `manual`, `priority`;
- `allowCrossProviderFallback`, default `false`;
- `maxConcurrentRunsPerProfile`, default `1`;
- `maxConcurrentRunsPerProvider`, default `1`;
- `maxTotalConcurrentRuns`, default `1` nell'MVP;
- `serializeWritesPerRepository`, default `true`;
- `continueBatchAfterFailure`, default `true` per errori task, `false` per errori infrastrutturali ripetuti;
- retry/backoff per classe di errore.

`minReservePct` non serve se espresso come `hardStopUtilizationPct`; conservarli entrambi creerebbe configurazioni contraddittorie.

### 11.6 Forecast e stime

Tenere modelli distinti:

- durata task per backend/profilo/modello/size;
- token/costo del run, quando osservabili;
- variazione di quota, solo se misurabile e con confidenza sufficiente;
- forecast della finestra dal suo storico nativo.

Usare mediana durante il cold start e p75/p95 per ammissione temporale. Registrare errore di stima e calibrare per profilo/modello. Non sommare cache token in modo identico tra provider senza conservare le categorie originali.

### 11.7 Efficienza token e contesto

Ci sono opportunità concrete e direttamente pertinenti al prodotto. Devono essere implementate come policy osservabili, non come prompt nascosti o presunte equivalenze con la quota.

#### 1. Session policy consapevole

- Default `new` per task indipendenti, così non viene trascinato un contesto lungo e irrilevante.
- `resume` solo per continuazioni/retry dello stesso task, stesso provider, stesso profilo e base repository compatibile.
- `auto` confronta costo storico di resume e fresh start per task simili.
- Se un run parziale ha prodotto un checkpoint conciso e artifact affidabili, preferire una nuova sessione con checkpoint al replay di una conversazione enorme.
- Non fare resume dopo fallback cross-provider.

Questa policy evita sia il costo del contesto accumulato sia la ripetizione di discovery già svolta. Va misurata: non esiste una scelta sempre migliore.

#### 2. Context manifest deterministico

Prima dello spawn, il sistema può produrre senza LLM un piccolo manifest:

- cwd e commit/base revision;
- file di istruzioni presenti e relativi hash;
- stato Git sintetico;
- capability/permessi concessi;
- artifact e checkpoint di run precedenti;
- acceptance criteria del task.

Il prompt deve referenziare file nel workspace invece di copiarne il contenuto. Output di comandi, log e diff vanno troncati/sintetizzati con regole deterministiche prima di diventare input del modello.

#### 3. Tool e MCP minimali per task

Ogni schema tool inserito nel contesto ha un costo. L'execution profile deve caricare solo tool, MCP server e directory necessari alle capability richieste. Profili “lean” che disattivano plugin, hook o istruzioni di progetto possono far risparmiare token, ma sono opt-in: rimuovere contesto progettuale può peggiorare sicurezza e qualità.

Il sistema deve mostrare cosa è stato escluso e non deve attivare una modalità lean per task write-scoped senza una convalida specifica.

#### 4. Routing a modello ed effort adeguati

- Definire per ogni task un quality floor e capability minime.
- Selezionare il modello meno costoso che storicamente supera quel floor per quella classe di task.
- Usare effort basso/medio per operazioni meccaniche e aumentarlo per pianificazione, debugging incerto o review ad alto rischio.
- Consentire un pattern opzionale “plan forte → execute economico” tramite un artifact di piano breve e strutturato.
- Non fare downgrade automatico se il task richiede esplicitamente un modello o una qualità minima.

Il routing si basa sui risultati locali (test, acceptance, retry), non su una classifica globale codificata nel prodotto.

#### 5. Prompt e output compatti

- Separare un prefisso stabile dalle parti dinamiche per favorire il prompt caching quando il provider lo supporta.
- Collocare dati altamente variabili nella sezione dinamica finale.
- Usare template per classe di task, senza ripetere boilerplate già presente nelle istruzioni del repository.
- Chiedere un risultato finale breve e strutturato: stato, cambiamenti, test, rischi, artifact.
- Non includere raw log nella risposta finale salvo errore o richiesta.
- Applicare output/token/cost limit solo se il backend lo supporta davvero; altrimenti registrarli come soft budget.

Nel client Claude locale esaminato esistono opzioni per model, effort, autocompact, system-prompt snapshot, esclusione di sezioni dinamiche per migliorare il cache reuse, JSON schema e — in modalità API — budget USD. Queste sono capability versionate del backend, non requisiti universali. Codex espone almeno model/profile, output schema e JSONL nella versione locale esaminata.

#### 6. Preflight senza modello

Eseguire controlli economici prima di consumare una turn:

- cwd esistente e repository valido quando richiesto;
- backend autenticato e sano;
- worktree creabile;
- dipendenze/task prerequisite soddisfatti;
- permessi compatibili;
- task duplicato o già soddisfatto secondo fingerprint conservativo;
- spazio disco e timeout sensati.

Il preflight non deve lanciare suite costose indiscriminatamente. Produce un report breve e strutturato che evita turn destinate a fallire per cause infrastrutturali.

#### 7. Retry che non amplificano il consumo

- Classificare errori `retryable`, `configuration`, `permission`, `quota`, `quality`, `terminal`.
- Non ritentare auth, path o permission error senza un cambiamento di stato.
- Usare backoff per rate limit/servizio.
- Conservare un checkpoint conciso del lavoro utile già fatto.
- Limitare retry per task e per batch, con circuit breaker per backend.
- Un retry su altro provider parte come nuovo run e riceve solo artifact portabili.

#### 8. Deduplica e raggruppamento controllato

- Calcolare una fingerprint da prompt normalizzato, cwd, base commit, profilo e policy per avvertire sui duplicati.
- Non riusare automaticamente un risultato se repository o acceptance criteria sono cambiati.
- Suggerire il raggruppamento di micro-task sullo stesso repository solo quando il contesto comune atteso supera l'overhead di coordinamento.
- Evitare batch monolitici: se un fallimento costringe a ripetere tutto, il presunto risparmio diventa amplificazione.

#### 9. Misurare prima di ottimizzare

Metriche per profilo/modello/classe di task:

- active e cached input token;
- output token;
- token per task riuscito;
- token spesi in run falliti/retry (`retry amplification`);
- cache hit ratio quando disponibile;
- percentuale di contesto stimata come boilerplate;
- durata, costo e quota delta osservata senza convertirli l'uno nell'altro;
- test/acceptance pass rate;
- interventi umani e rework.

La metrica guida è **lavoro utile riuscito per unità di consumo**, non “meno token” in assoluto. Un modello più economico che richiede tre retry è spesso meno efficiente.

### 11.8 Ottimizzazioni da non promettere

- Il polling della quota non deve invocare una turn generativa solo per leggere lo stato; senza una sorgente passiva/supportata, si mostra `unavailable`.
- Il sistema non deve dichiarare quanti token equivalgono a un punto percentuale di subscription.
- Il caching non va contato come risparmio finché il backend non espone metriche osservabili.
- Compattare o riassumere con un altro modello non è gratis: va fatto solo quando il riuso previsto supera il costo della sintesi.
- Spezzare un task non è sempre efficiente; può duplicare discovery e test.
- Disabilitare istruzioni, hook o tool può ridurre input ma aumentare errori e rischio.

## 12. Telemetria Codex: spike obbligatorio

Lo spike produce un documento e fixture, non codice di produzione collegato a endpoint non supportati.

### Domande

1. I dati account mostrati da `/usage` sono ottenibili tramite un'interfaccia non interattiva, documentata e machine-readable, senza avviare una turn generativa?
2. `codex app-server generate-json-schema` espone dati usage stabili o soltanto funzioni sperimentali?
3. `codex exec --json` include token, modello, reasoning, speed, crediti o soli eventi di run?
4. Quali dati locali sono documentati e quali sono dettagli interni soggetti a cambiamento?
5. La dashboard Usage espone un'API ufficiale utilizzabile da client locali?
6. Come cambiano dati e semantics tra login ChatGPT e API key?
7. Le attività avviate da superfici diverse compaiono nello stesso contatore e con quale ritardo?

### Matrice di classificazione

Per ogni campo annotare:

- sorgente e versione;
- structured vs testo/UI;
- supportata vs sperimentale vs privata;
- unità e scope;
- latenza/freschezza osservata;
- autenticazione richiesta;
- possibilità di redazione dei segreti;
- failure mode;
- fixture e parser test;
- idoneità a `display`, `manual warning` o `automatic admission`.

### Gate di adozione

- **Tier A — supportato e strutturato:** può governare l'automazione.
- **Tier B — documentato ma incompleto:** display e policy conservative.
- **Tier C — sperimentale o locale non documentato:** feature flag, nessuna decisione automatica di default.
- **Tier D — scraping/private endpoint:** escluso dal prodotto stabile.
- **Nessun dato:** Codex execution resta manuale o governata da un budget API configurato; routing `auto` non lo sceglie per ottimizzare subscription.

## 13. Concorrenza, recovery e processi

### MVP

Mantenere `maxTotalConcurrentRuns = 1`, ma sostituire il nome del lock con una risorsa neutra. Questo permette di introdurre Codex senza riscrivere subito la supervisione concorrente.

### Evoluzione

Per aumentare la concorrenza:

- claim SQL condizionale e lease con `ownerId`, `expiresAt`, heartbeat;
- limiti acquisiti transazionalmente per globale/profilo/provider/repository;
- processo scheduler persistente o daemon responsabile dello spawn, invece di un processo detached per ogni poll;
- cancellazione che segnala il process group e attende cleanup;
- recovery che distingue processo perso, lease scaduta e run terminato senza flush;
- idempotency key per start batch/run;
- backoff con jitter sui guasti infrastrutturali.

Il PID da solo non è un'identità sufficiente a causa del riuso dei PID. Salvare anche start time/owner token e verificare heartbeat.

## 14. Dashboard aggregata e semantica delle metriche

### Card provider/profilo

Mostrare separatamente:

- stato backend;
- ogni finestra/credito/spesa;
- valore e unità;
- reset;
- forecast se disponibile;
- margine rispetto alla soglia dura;
- source kind, captured time e age;
- quality badge: `healthy`, `near-limit`, `stale`, `unavailable`, `error`.

Il colore deve avere anche testo/icona accessibile; non affidarsi al solo colore.

### Aggregazioni consentite

- task/run completati;
- success/failure/cancel rate;
- durata;
- throughput;
- token, solo con breakdown provider e categorie;
- costo nella stessa valuta e con campo `estimated/observed`;
- utilizzo per modello;
- accuratezza stime;
- tempo perso in attesa e principali reason code.

### Aggregazioni vietate

- somma di percentuali quota;
- conversione automatica token → percentuale subscription;
- costo API presentato come costo incluso dell'abbonamento;
- una sola freschezza globale;
- “budget totale residuo” senza unità comparabile.

La heatmap ha selettore esplicito (`runs`, `duration`, `tokens`, `cost`) e non cambia unità silenziosamente.

## 15. Piano di implementazione per fasi

Ogni fase deve poter essere rilasciata dietro flag e lasciare funzionante il percorso Claude attuale.

### Fase 0 — Igiene dei branch e clean rename

Questa fase cambia in modo coordinato tutta l'identità del progetto. Non lascia doppi launcher, doppi path, alias MCP o unità con nomi precedenti.

**Rename gate esatto:** preparare e validare il clean rename sul branch dedicato; eseguire il rename su GitHub dopo che #10 e #11 sono mergiate, #12 è stata chiusa o sostituita senza perdere la parte utile e `main` passa la CI; subito dopo aggiornare `origin`, pubblicare il branch dedicato e mergiarlo prima della Fase 0A. Così le PR già aperte si chiudono senza retargeting e nessuna release espone una configurazione ibrida.

Deliverable:

1. merge #10, poi riallineamento e merge #11;
2. conferma della semantica di delete permanente introdotta da #12;
3. CI minima su `typecheck` e test, quindi ruleset/protezione di `main`;
4. clearance finale del nome scelto e registrazione della decisione **LLM Squeeze**;
5. rename dello slug GitHub corrente in `damn-fine-pizza/llm-squeeze`;
6. sostituzione coordinata di package, launcher, home directory, variabile ambiente, unità, plugin e MCP con l'identità `llm-squeeze`;
7. aggiornamento immediato di `origin`, URL in `package.json`, `config.update.repository`, installer/updater, badge, link e documentazione;
8. aggiunta del remote read-only `upstream` verso il repository sorgente indicato dalla fork network e documentazione della sync policy;
9. verifica di clone, fetch, update e install sia dall'URL nuovo sia tramite il redirect GitHub del vecchio URL;
10. changelog e README che dichiarano rename, continuità del fork e natura breaking del cambio runtime.

Exit criteria:

- tutte le PR da conservare sono raggiungibili da `main` e i rispettivi branch remoti sono eliminabili;
- `main` è verde e protetto da merge accidentali senza check;
- il repository nuovo è la sorgente canonica e il vecchio URL redirige;
- updater/installer non puntano più in modo canonico al vecchio slug;
- `llm-squeeze` è installato, documentato e coperto da smoke test;
- una ricerca repository-wide non trova identificatori di branding precedenti;
- package, launcher, MCP, unità e `~/.llm-squeeze` espongono tutti la stessa identità;
- il repository resta nella rete di fork e l'attribuzione upstream è visibile.

### Fase 0A — Baseline e migration harness

Deliverable:

- fixture di DB delle versioni rilasciate;
- migration runner e connection factory;
- contract test dell'attuale Claude provider/runner;
- inventory dei consumer Claude-specifici;
- feature flags `taskWorkspaceV2`, `multiProviderExecution`, `budgetV2`, `schedulerV2`.

Exit criteria:

- upgrade concorrente e riavvio idempotente;
- nessuna perdita su snapshot, task, run e usage esistenti;
- suite attuale invariata;
- rollback applicativo possibile tramite backup pre-migrazione, non tramite un secondo percorso runtime.

### Fase 0B — Spike telemetria Codex

Deliverable:

- observation matrix prevista nella sezione 12;
- fixture redatte di `codex exec --json` e delle sole sorgenti usage ammissibili;
- decisione ADR sulla sorgente budget Codex;
- comportamento definito per unavailable/stale.

Exit criteria:

- nessuna credenziale nei fixture/log;
- ogni campo ha unità, scope e reliability;
- il tier di adozione è approvato;
- nessun parser TUI nel percorso stabile.

Le fasi 0A e 0B possono procedere in parallelo.

### Fase 1 — Dominio e persistenza v2

Slice consigliate:

1. profili provider predefiniti e registry;
2. task v2 + migrazione sidecar schedule meta;
3. revisioni task e optimistic locking;
4. run v2 con snapshot immutabile;
5. batch, item e decision log.

Exit criteria:

- lettura/scrittura atomica via service layer;
- mapping completo dei task pre-migrazione;
- invarianti di stato testate;
- CLI e MCP vengono aggiornati insieme e continuano a funzionare tramite lo stesso service layer.

### Fase 2 — Task workspace

Slice consigliate:

1. API CRUD e validazione;
2. lista, filtri e dettaglio;
3. editor Markdown + preview sicura;
4. autosave e conflitti;
5. drag-and-drop e reorder transazionale;
6. duplicazione, pausa, archivio e restore;
7. cronologia revisioni e rollback.

Exit criteria:

- tutte le operazioni disponibili da dashboard;
- nessuna perdita su refresh/concorrenza;
- prompt grande limitato con errore chiaro;
- test XSS/CSRF e origin/host;
- accessibilità base da tastiera per il reorder, oltre al drag-and-drop.

### Fase 3 — Execution model multi-provider

Slice consigliate:

1. estrazione `ClaudeExecutionBackend` senza variazioni funzionali;
2. capability e authorization profiles;
3. `CodexExecutionBackend` dietro flag;
4. parser eventi/result normalizzato;
5. health/doctor per profilo;
6. worktree e artifact per-run;
7. retry taxonomy e resume confinato;
8. context policy `new/resume/auto` e output strutturato;
9. profili Codex `read-only`, `workspace-auto`, `workspace-review` e `isolated-yolo` con capability gate.

Exit criteria:

- fake binary integration test per entrambi i backend;
- argomenti CLI verificabili senza shell;
- timeout/cancel/crash recovery coperti;
- destructive sempre manual-only;
- fallback non aumenta permessi;
- un run Codex manuale produce risultato e metriche normalizzate.
- i budget token/costo sono marcati hard o soft secondo le capability effettive.
- `auto` e fallback non possono selezionare `isolated-yolo`; senza attestazione del runner esterno quel profilo è `ineligible`.

### Fase 4 — Batch e explainability

Slice consigliate:

1. preview pura e deterministica con fake clock;
2. creazione batch idempotente;
3. claim e rivalutazione per task;
4. stop admission e cancellazione separati;
5. progress dashboard/MCP/CLI;
6. reason-code catalog stabile.

Exit criteria:

- ogni item finisce in uno stato terminale o resta esplicitamente pending;
- differenze preview/execute spiegate;
- un errore task non perde gli item restanti;
- stop non uccide implicitamente il run corrente;
- restart ricostruisce correttamente batch e run.

### Fase 5 — Budget v2 e home multi-provider

Slice consigliate:

1. storage dinamico osservazioni/finestre;
2. adapter compatibile per i tre valori Claude correnti;
3. freschezza per profilo e retention;
4. sorgente Codex al tier consentito dallo spike;
5. API e card multi-provider;
6. forecast separati e quality badge;
7. migrazione di notification key a `profile + window`.

Exit criteria:

- errore di un provider non rimuove l'ultimo dato noto degli altri;
- nessun `providers["claude"]` nel codice generico;
- finestre sconosciute vengono conservate e mostrate;
- stale/unavailable non appare healthy;
- nessuna metrica eterogenea viene sommata.

### Fase 6 — Scheduler v2

Slice consigliate:

1. hard gates e cutoff reset;
2. ordinamento manual/priority;
3. stime per profilo/modello;
4. routing fisso e `auto` senza fallback;
5. fallback opt-in;
6. availability policy;
7. simulazione “quanti task?”;
8. concorrenza oltre 1, solo dopo test lease/repository lane;
9. routing model/effort con quality floor;
10. preflight, dedup conservativa e retry amplification guard;
11. context manifest e suggerimenti di session policy.

Exit criteria:

- property test: nessun hard gate viene bypassato dallo scoring;
- task stale fixed-provider automatico held con ragione;
- `auto` non sceglie dati inaffidabili per ottimizzare quota;
- nessun nuovo task parte dopo cutoff;
- deadline e p95 duration sono verificati prima del claim;
- decisione riproducibile dagli input salvati.
- nessuna ottimizzazione token viene abilitata senza baseline e quality guard.

### Fase 7 — Osservabilità e UX completa

Deliverable:

- timeline reset;
- history batch/run;
- efficacia stime;
- provider/model breakdown;
- dashboard di efficienza corretta per qualità, cache e retry;
- heatmap multi-metrica;
- filtri salvati opzionali;
- log rotation e retention configurabile;
- export/import JSON + Markdown con schema versionato.

Exit criteria:

- dashboard resta usabile con migliaia di task/run tramite paginazione;
- ogni numero mostra unità e scope;
- export/import round-trip coperto;
- stato vuoto, stale, partial e failure sono testati.

### Fase 8 — Hardening

- chaos/fault tests su crash, DB busy, CLI mancante, output corrotto e reset modificato;
- audit privacy e redazione;
- verifica che packaging, servizi, plugin e directory dati mantengano una sola identità;
- rimozione del comando one-shot di import dati prima della release stabile, dopo averne conservato lo script versionato fuori dal runtime;
- audit dei riferimenti e contract test sull'identità pubblica.

## 16. Strategia di test

### Unit

- state machine e invarianti;
- ordinamento e reorder;
- policy di ammissione con fake clock;
- freshness/quality e cutoff;
- mapping capability/authorization;
- parser fixture Claude/Codex;
- stime e forecast per profilo.

### Property-based

- nessun valore oltre hard stop viene ammesso;
- fallback non amplia permessi;
- reorder conserva tutti e soli gli id;
- transizioni illegali vengono rifiutate;
- percentuali eterogenee non entrano in aggregazioni globali.

### Integration

- DB upgrade da ogni fixture;
- due processi che tentano claim/reorder/autosave;
- fake CLI lenti, corrotti, rumorosi e terminati;
- crash tra claim, run insert, spawn e settle;
- due profili con un provider stale e uno healthy;
- conflitto tra run write-scoped sullo stesso repository.

### HTTP/MCP

- parity tra trasporti sullo stesso service layer;
- optimistic locking e `409`;
- body limit, input path e Markdown malevolo;
- Host/Origin/CSRF/CSP;
- paginazione e rate limit locale sulle mutazioni sensibili.

### End-to-end

- crea → autosave → reorder → preview → run → result → archive;
- Claude fixed;
- Codex fixed;
- `auto` con fallback disabilitato/abilitato;
- cutoff a 60 minuti;
- restart durante batch;
- budget unavailable con comportamento fail-closed.

## 17. Sicurezza e privacy

- Bind dashboard e MCP HTTP solo a loopback per default.
- Conservare i controlli Host/Origin e aggiungere token CSRF/capability per le mutazioni browser.
- Applicare CSP; nessun CDN o script inline non autorizzato.
- Validare/normalizzare cwd senza assumere che una stringa sia un repository sicuro.
- Passare sempre argv strutturati a `spawn`/`execFile`.
- Redigere token, header, path sensibili e payload provider prima di log/DB.
- Imporre limiti a prompt, raw JSON, stdout/stderr e revision history.
- Non copiare file di autenticazione nei worktree o negli artifact.
- Network e directory aggiuntive devono essere capability esplicite.
- Ogni override manuale di budget o sicurezza deve essere registrato.
- Nessuna telemetria esterna introdotta dal progetto.

## 18. Rollout e migrazione

1. Consolidare le PR correnti e introdurre CI/protezione.
2. Al rename gate, rinominare il repository GitHub in `llm-squeeze` e applicare insieme il clean rename già validato sul branch dedicato.
3. Rilasciare migration runner senza schema funzionale nuovo.
4. Aggiungere proiezioni v2 in shadow mode interno e confrontarle con l'output corrente prima dello switch atomico.
5. Rendere disponibile il task workspace dietro flag.
6. Estrarre Claude adapter mantenendo test snapshot/fixture.
7. Abilitare Codex solo per run manuali e senza profilo `isolated-yolo` predefinito.
8. Abilitare batch con provider fisso.
9. Abilitare budget v2 in sola visualizzazione.
10. Abilitare scheduler v2 per Claude, poi Codex quando il tier telemetria lo permette.
11. Abilitare `auto` e fallback solo per opt-in esplicito.
12. Confermare con un audit repository-wide che esiste una sola identità pubblica e un solo percorso runtime.

Garanzie di migrazione obbligatorie:

- `llm-squeeze` è l'unico binario installato;
- l'URL GitHub precedente continua a redirigere e installer/updater usano quello nuovo;
- i tool MCP attuali restano registrati;
- un import one-shot può trasformare una configurazione o un DB pre-release, ma non rimane nel daemon né nel normale startup;
- ogni migrazione crea un backup verificato prima del copy-and-swap;
- dopo lo switch non esistono lettori, alias o fallback per i nomi sostituiti;
- il rollback usa il backup pre-migrazione e la release precedente, non uno schema ibrido.

## 19. Rischi principali e mitigazioni

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Telemetria Codex non supportata | Routing quota-aware non affidabile | Gate Tier A/B; manual-only o budget API. |
| Schema aggiunto senza migration runner | DB esistenti incompatibili | Fase 0A obbligatoria e fixture storiche. |
| Troppa UI nell'HTML inline | Regressioni e manutenzione difficile | Sorgenti modulari compilate in asset locali. |
| Doppia esecuzione dopo crash | Modifiche/costi duplicati | Claim atomico, lease, heartbeat, idempotency key. |
| Due run scrivono nello stesso repo | Conflitti e perdita di lavoro | Repository lane + worktree per run. |
| Autosave sovrascrive MCP | Perdita prompt/metadati | Revision + optimistic locking. |
| Fallback cambia comportamento | Risultato o permessi inattesi | Opt-in, capability intersection, nuovo run non-resume. |
| Percentuali presentate come confrontabili | Decisioni utente errate | Unit/scope obbligatori e aggregazioni vietate. |
| Regole commerciali cambiano | Parser/config obsolete | Finestre dinamiche, raw redatto, source version. |
| Cutoff interpretato come kill | Lavoro interrotto | Separare stop admission da cancel active. |
| Retention output/worktree cresce | Disco pieno/dati sensibili | Policy retention, size limits, cleanup conservativo. |
| Ottimizzazione token riduce qualità | Più retry, rework e rischio | Quality floor, rollout shadow/A-B locale e rollback per policy. |
| Resume trascina contesto obsoleto | Consumo e decisioni peggiori | Policy new/resume/auto, fingerprint base e checkpoint conciso. |
| Profilo lean omette istruzioni essenziali | Modifiche non conformi | Opt-in, capability gate e confronto acceptance/test. |
| `yolo` usato come scorciatoia unattended | Accesso host/rete non contenuto | Profilo separato, runner esterno attestato, mai selezionato da `auto`/fallback. |
| `LLM Squeeze` interpretato come compressore/quantizzatore | Posizionamento poco chiaro | Payoff e README aprono con quota-aware backlog/scheduler; “compression” non è una capability dichiarata. |
| Rename GitHub rompe updater/link hardcoded | Install/update falliscono | Inventory riferimenti, redirect testato, URL canonici aggiornati nella Fase 0. |
| Detach prematuro del fork | Perdita permanente di metadati e provenienza meno chiara | Mantenere il fork; rivalutazione separata solo dopo release stabile. |

## 20. Criteri di successo rivisti

La prima release multi-provider è riuscita quando:

- un DB esistente viene aggiornato senza perdita tramite migrazione atomica e backup verificato;
- task e prompt Markdown sono gestibili interamente dalla dashboard;
- autosave e MCP non si sovrascrivono silenziosamente;
- l'ordine manuale è stabile e la modalità priority è esplicita;
- Claude e Codex possono eseguire un task fisso con la stessa semantica normalizzata di run;
- un batch ha preview, stato, stop e decision log;
- nessun nuovo task viene ammesso entro il cutoff configurato dal reset;
- task distruttivi non partono unattended;
- fallback è opt-in e non amplia i permessi;
- ogni task eseguito/rimandato/scartato ha una reason code e una spiegazione;
- ogni card budget mostra unità, scope, sorgente, qualità e freschezza;
- Claude e Codex sono visibili insieme senza una falsa percentuale totale;
- l'assenza di telemetria Codex degrada il routing in modo sicuro senza impedire i run manuali;
- crash e restart non producono doppie esecuzioni nei test;
- CLI, package, servizi, plugin e MCP espongono unicamente `llm-squeeze`;
- repository rinominato, fork e attribuzione preservati, vecchio URL verificato;
- token per task riuscito e retry amplification migliorano senza ridurre acceptance/test pass rate.

## 21. Decisioni consigliate da fissare subito

1. Usare `docs/MULTI_PROVIDER_AGENT_SCHEDULER_PLAN.md` come piano principale e mantenere `QUOTA_PACING_PLAN.md` come storico dell'implementazione Claude già completata.
2. Le PR #10, #11 e #12 sono mergiate; la delete permanente non richiede archive, revisioni né migration.
3. Adottare definitivamente **LLM Squeeze**: repository `llm-squeeze` e binario canonico `llm-squeeze`.
4. Rinominare il repository GitHub al rename gate della Fase 0, mantenere il fork e applicare il clean break senza shim.
5. Non iniziare dal redesign visivo: iniziare da migration runner e service layer.
6. Tenere execution e budget adapter separati.
7. Trattare `provider profile`, non il solo provider, come unità di quota e concorrenza.
8. Conservare concorrenza globale a 1 nell'MVP.
9. Usare Markdown sicuro, non WYSIWYG.
10. Rendere preview obbligatoria nel flusso dashboard “Run queue”.
11. Definire il cutoff come stop-admission.
12. Escludere scraping e API private dai criteri di completamento.
13. Distinguere Codex unattended confinato da `yolo`; il secondo non entra nel routing automatico.
14. Trattare risparmio token come ottimizzazione quality-adjusted e misurata, non come obiettivo assoluto.

## 22. Primo backlog operativo

Ordine concreto delle prime pull request, ciascuna piccola e reversibile:

1. proteggere `main` e decidere se eliminare i branch remoti delle PR già mergiate;
2. consolidamento del workflow CI + ruleset `main` con check richiesti;
3. rename gate: GitHub → `llm-squeeze`, clean rename completo, aggiornamento link/updater/remote;
4. migration runner, connection factory e fixture DB pre-migrazione;
5. tipi provider/profile/budget v2 senza cambiare runtime;
6. `TaskService` con modello v2 e migrazione atomica dal modello corrente;
7. task revision + optimistic concurrency;
8. API CRUD task e test di sicurezza;
9. UI lista/editor/autosave;
10. reorder e modalità di coda;
11. estrazione del backend Claude con contract fixture;
12. run v2, artifact e decision schema;
13. Codex execution spike + backend manual-only;
14. profili Codex confinati; spike `isolated-yolo` solo su runner esterno;
15. batch preview/execute/stop;
16. budget storage v2 e adapter Claude;
17. telemetria Codex secondo ADR dello spike;
18. home multi-provider;
19. scheduler v2 per provider fisso;
20. routing `auto` e fallback opt-in;
21. concorrenza multi-run soltanto dopo lease e repository lane;
22. session/context optimization in shadow mode, poi rollout per profilo sulla base delle metriche;
23. audit finale di identità, packaging e documentazione; nessun alias runtime.

Questo ordine sistema prima la storia remota e l'identità pubblica, consegna valore utente al punto 9, riduce il rischio prima di Codex e impedisce che l'intero progetto resti bloccato dalla disponibilità di una sorgente quota perfetta.
