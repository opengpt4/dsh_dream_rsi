# DeepSeek Dream-RSI Harness Plugin 功能規格

**版本**：1.1
**狀態**：Implementation baseline，持續擴充中
**適用架構**：Cordis Plugin  
**主要依據**：[requirement1](requirement1)、[requirement2](requirement2)、[requirement3](requirement3)

目前 repository 已驗證 Node.js/TypeScript ESM baseline、Cordis reversible
tool lifecycle、mock embodied tools/events、Discovery/SQLite storage、Replay、
Q/C/P/M evaluator、task-level split、Monotonic Gate、immutable snapshot、
process-isolated evaluator、lease lock 與 validated configuration。`npm test`
目前通過 24 個測試。Profile/patch adapter、完整 OS/container sandbox、
candidate generation、canary deployment、tool synthesis 與 real simulator
adapter 仍屬後續實作範圍。

## 1. 目的與範圍

建立一個可載入 Cordis 的 DeepSeek Harness Plugin，讓 Agent 能在固定的 DeepSeek 模型之上，持續改進「任務分解、工具調度、探索、剪枝與成本控制」策略。

本產品的自我改進對象是 Harness policy 與可重用工具，不是模型權重。系統透過 Dream-RSI 的三段迴路工作：

1. **真實探索**：在受控環境執行任務並記錄完整軌跡。
2. **離線做夢**：使用歷史軌跡建立確定性 Replay Simulator，不呼叫模型、不執行沙盒。
3. **受控部署**：候選 policy 只有在品質不劣化、安全檢查與資源門檻都通過後才可啟用。

Embodied AI 在本規格中指「感知/狀態 -> 決策 -> 行動 -> 環境回饋」的閉環介面。第一期以 DSH 既有 agent loop 為主，透過 tools、events 與 backend service 接入數位環境；不預設替換整個 loop。實體機器人、真實硬體驅動器與安全認證不在 MVP 範圍內，但介面需可擴充。

## 2. 目標與非目標

### 2.1 目標

- 以 Cordis Plugin 形式啟停、配置與管理功能。
- 使用既有 Harness LLM client 呼叫 DeepSeek，集中記錄 token、延遲與錯誤。
- 將每次任務形成可重播的 Discovery DAG。
- 在離線回放中比較 current policy 與候選 policy。
- 將成功的重複步驟候選化為可審核的工具。
- 提供人工可觀測、可停止、可回滾的自我改進流程。
- 以任務品質、成本、延遲與探索效率作為多目標評估。

### 2.2 非目標

- 不修改、訓練或微調 DeepSeek 模型權重。
- 不宣稱離線模擬器能預測歷史資料以外的未知結果。
- 不允許候選程式直接存取主機、未授權網路、秘密或任意檔案。
- MVP 不做全自動實體機器人控制，不繞過人類安全核准。
- 不把自然語言經驗摘要直接當成硬性剪枝規則；可保存為診斷資料，但不得自動改變 policy 行為。

## 3. 使用者與核心情境

| 角色 | 需求 |
|---|---|
| Agent 使用者 | 在 Cordis 對話或任務中使用 DeepSeek Agent 與工具。 |
| 系統管理者 | 查看成本、啟停自我改進、審核候選 policy/tool、回滾版本。 |
| Policy Engineer | 檢查探索策略、評估報告與失敗軌跡。 |
| Embodied Environment Adapter | 提供觀測狀態、可執行 actions 與結果回饋。 |

主要情境：

1. 使用者送出任務，Plugin 根據 current policy 決定是否分解、並行、重試或剪枝。
2. 任務完成後，系統保留可重播資料與成本指標。
3. 管理者觸發或排程 `evolve`，產生候選 policy，在歷史任務上離線比較。
4. 候選通過安全閘門後，以 canary 或人工核准方式啟用。
5. 新版線上表現異常時，管理者或自動監控觸發回滾。

## 4. Cordis 整合模型

Plugin 應採用 Cordis 的 Context、Service、Schema 與 plugin lifecycle 慣例；不得把 Cordis runtime 直接耦合到核心演算法。若實際 Cordis 版本 API 名稱不同，必須由 adapter 層隔離差異。

### 4.1 Plugin lifecycle

- `apply(ctx, config?)`：先驗證配置，再註冊服務、事件、指令與配置 schema。
- `ready`：確認資料庫、policy、工具 registry 與沙盒能力可用。
- `dispose`：停止 worker、關閉資料庫、取消未完成的離線演進。

Plugin 的註冊必須使用 DSH/Cordis 提供的 context 與可逆 effect。正式掛載應支援 Harness profile 與 `cordis.patch.yml`；卸載 plugin 後，tools、events、services 與 worker 不得殘留。

目前 `apply()` 已透過 `ctx.effect()` 管理 embodied tool registration，並在
disposer 中反向 unregister。`resolveDreamRsiConfig()` 提供安全預設：
evolution、auto-deploy 與 embodied execution 預設關閉；invalid split ratios
或 `autoDeploy=true` 但 evolution 未啟用時，會在任何 registration 前失敗。

### 4.2 建議 Cordis 服務

- `ctx.deepseekHarness`：任務執行、LLM 呼叫與 tool dispatch facade。
- `ctx.dreamRsi`：Discovery Store、Replay、Evaluator、Evolution、Deployment facade。
- `ctx.dreamRsi.metrics`：成本、品質、版本與失敗指標。
- `ctx.embodiedBackend`：依 session 提供 observation、action 與 world-state 存取。

Embodied plugin 的預設整合方式是註冊 tools、typed events 與 backend service；只有在需要自訂規劃迴路時，才另外掛載 loop plugin。不得讓 Dream-RSI 核心依賴特定 simulator 或機器人 SDK。

### 4.3 事件

事件名稱可依 Cordis 實際事件系統映射，但語意必須保持一致：

- `dream-rsi/task-start`
- `dream-rsi/action-before`
- `dream-rsi/action-after`
- `dream-rsi/task-end`
- `dream-rsi/evolution-start`
- `dream-rsi/evolution-result`
- `dream-rsi/policy-deployed`
- `dream-rsi/rollback`
- `embodied/action-started`
- `embodied/action-completed`
- `embodied/frame`
- `embodied/error`

事件 payload 必須包含 `taskId`、`policyVersion`、時間戳與 correlation id；不得在一般 log 中寫入 API key、完整秘密或不必要的個人資料。

### 4.4 管理指令

指令名稱可加上 Cordis adapter 的命名空間，建議提供：

- `dream status`：目前 policy、最近評估、啟用工具與資源使用。
- `dream evolve [taskId]`：啟動一次離線演進。
- `dream evaluate <policyVersion>`：只評估、不部署。
- `dream policy list|show|rollback <version>`：版本管理。
- `dream tools list|approve|disable <tool>`：工具審核與停用。
- `dream pause|resume`：暫停或恢復自我改進 worker。

所有管理指令需檢查 Cordis 使用者權限；`evolve`、`approve`、`deploy`、`rollback` 不可開放給一般頻道使用者。

## 5. 功能需求

### FR-01 DeepSeek Provider

1. 所有模型請求必須經由 Harness 的 `llm.invoke()` adapter。
2. 配置支援 model、temperature、timeout、最大 token 與 retry budget。
3. 每次呼叫保存 request hash、response hash、token、延遲、錯誤類型與 task id。
4. API credential 只從 secret provider 或環境注入，不進資料庫與候選程式。
5. provider 失敗時依配置重試；重試耗盡後將 action 標為 failed，不得無限迴圈。

### FR-02 任務與 Embodied Action Loop

1. 任務輸入包含 `taskId`、goal、budget、environmentId 與 metadata。
2. Environment Adapter 提供：
   - `observe() -> Observation`
   - `available_actions(state) -> ActionSchema[]`
   - `execute(action) -> ActionResult`
   - `reset()`
3. Policy 只可從已註冊 action/tool schema 選擇行動。
4. 每個 action 必須有 timeout、取消信號、資源預算與結果狀態。
5. 感知內容可包含文字、結構化狀態或外部 observation reference；大型二進位資料應使用外部 artifact store。
6. 每個 Harness session 必須有獨立的 backend context，session 結束時釋放場景、連線與暫存狀態，不得跨 session 洩漏 world state。
7. MVP 必須註冊以下 model-callable tools：
  - `embodied_perceive`：依 sensor 類型回傳精簡 observation、物件列表、pose 與 timestamp。
  - `embodied_act`：執行受 allowlist 保護的高階 action，例如 `move_relative`、`goto`、`pick`、`place`、`open`。
  - `embodied_query_state`：查詢 room graph、物件、導航節點或其他受控 world model 資訊。
8. `embodied_act` 必須回傳 `success`、`actionId`、result/error 與最新 state reference；開始、完成及錯誤都必須發布 typed event。
9. observation 輸出須以模型可用的短文字與結構化 JSON 為主；影像、depth、point cloud 等大型資料應使用 artifact reference，只有明確要求時才內嵌 base64。

### FR-03 Discovery DAG

每個節點至少記錄：

- `nodeId`、`taskId`、`parentId`、`policyVersion`
- action type、tool name、輸入 hash、prompt mutation metadata
- observation reference、模型結果 reference、tool/sandbox 結果
- exit code、錯誤類型、品質分數
- input/output token、執行時間、critical path time
- 建立時間、correlation id、資料 schema version

系統必須支援依 task、policy、時間與結果查詢，並對 `taskId`、`parentId`、`policyVersion` 建立索引。寫入需具備冪等鍵，避免重試造成重複節點。

每個 embodied episode 需額外記錄 `sessionId`、`environmentId`、observation reference、actionId、action type、參數 hash、result reference 與 episode step，讓事件、工具呼叫與 Discovery DAG 可互相重播。

### FR-04 Replay Simulator

1. Simulator 只讀取已封存的 Discovery DAG 與 artifact，不呼叫 DeepSeek、不啟動 Docker/外部工具。
2. 相同輸入與相同 simulator snapshot 必須得到相同結果。
3. Replay 不得只以 `nodeId` 判斷命中。每次 action 必須使用以下 immutable replay key：

  ```text
  environmentVersion
  + stateHash
  + actionType
  + normalizedActionParams
  + observationHash
  ```

4. 命中已知 action 時回傳歷史 transition；未命中時回傳 `BOUNDARY_MISS`，並記錄可用替代 action 與停止原因。
5. Simulator 必須支援 counterfactual branch：同一 state 可比較多個歷史 action，而不必重跑 LLM 或外部環境。
6. Replay 結果必須包含 hit、miss、visited nodes、counterfactual branches、模擬成本與關鍵路徑。
7. Replay snapshot 必須有版本與 hash，評估報告需引用該 snapshot。

### FR-05 Policy Evolution

1. Evolution Agent 可讀取 policy source、型別契約、評估結果與 replay snapshot。
2. 候選修改限於調度控制流、優先級、並行度、預算分配、早停與剪枝。
3. 候選必須輸出 source、diff、metadata、依賴清單與可重現 build identifier。
4. 任何候選先經 AST guard，再進行 replay，再經 monotonic gate。
5. 預設模式為 `evaluate-only`；自動部署需明確開啟，且可設定人工核准。
6. 同一 base policy、snapshot、seed 與 config 應產生可比較的評估結果。

### FR-06 評估與部署閘門

品質、成本、平行效率與邊界風險分開保存，不只保存單一總分：

```text
Q = normalized best task quality
C = normalized token cost + execution cost
P = normalized work / critical-path time
M = boundary miss rate
S = wq*Q - wc*C + wp*P - lambda*M
```

候選要部署必須同時滿足：

- AST、安全與依賴檢查通過。
- replay miss rate 不超過配置上限。
- 在至少 95% 的歷史案例上品質不低於 current policy，比例可配置。
- `S(candidate) >= S(current) + minimumImprovement`。
- 沒有超過 token、時間、並行 worker 或磁碟預算。
- canary 任務通過後才可擴大啟用。

「不劣化」與「顯著改善」需分開判定，避免微小噪聲造成頻繁 hot-swap。

評估資料必須依 task 與 episode 分為三組：

- `train`：允許 Evolution Agent 使用，預設 70%。
- `validation`：用於調整候選參數，預設 15%。
- `holdout`：候選生成完成後才可使用，預設 15%，不可被候選程式讀取。

候選必須在 holdout 上通過最低品質、成本與安全門檻。評估報告要分別列出每個 task family 的結果、信賴區間與樣本數，不能只依賴全體平均分數。

評估器、baseline policy、holdout 資料與門檻配置必須在候選程式之外的隔離 process/container 執行。候選不得讀取或修改 evaluator、測試資料、deployment registry、秘密或評估內部狀態。評估結果需包含 evaluator version、source hash 與簽章。

### FR-07 Tool Synthesis

1. 從成功軌跡提出工具候選，不得直接啟用。
2. 候選須包含名稱、版本、輸入/輸出 JSON Schema、source、測試、權限與依賴。
3. 生成工具先在隔離 runner 執行單元測試、contract test 與 AST guard。
4. 經管理者核准或明確自動化政策通過後，才寫入 Dynamic Tool Registry。
5. 工具可被停用、版本化、回滾；policy 不得依賴已停用工具。
6. 合成的 embodied tool 預設只能使用高階 action primitive，不得直接暴露 joint velocity、raw motor command 或未封裝的硬體通道。

### FR-08 版本、回滾與故障處理

- policy、tool、replay snapshot 與評估報告皆不可變版本化。
- 保留至少 N 個最後穩定版本，N 可配置，預設 3。
- 啟用後若錯誤率、成本或品質超過警戒線，標記 degraded 並可自動回滾。
- 回滾必須產生事件、原因、操作者與前後版本。
- 離線演進失敗不可影響線上任務執行。
- 同一時間只能有一個 evolution/deployment writer；job 需要可恢復、可取消並具備 lease timeout。
- policy、tool、evaluator 與 replay snapshot 必須透過 immutable artifact reference 綁定，避免評估後輸入被替換。

## 6. 資料模型

核心實體：

- `Task`：目標、環境、預算、狀態與最終品質。
- `DiscoveryNode`：一次 observation/action/result 的 DAG 節點。
- `PolicyVersion`：source hash、父版本、狀態、啟用時間與分數。
- `ReplaySnapshot`：節點/artifact 集合的 immutable snapshot hash。
- `Evaluation`：Q/C/P/M、總分、測試數、通過比例與 guard 結果。
- `ToolVersion`：schema、source hash、測試結果、權限與狀態。
- `Deployment`：版本、canary 結果、操作者與 rollback 資訊。
- `Episode`：session、environment、step、observation、action、transition 與 outcome。
- `EvaluationSplit`：train/validation/holdout 的 task membership、版本與 hash。
- `CapabilityProfile`：環境支援的 sensors、actions、座標系、風險等級與安全限制。

MVP 優先使用 SQLite，透過 repository interface 隔離儲存層；多 worker 或多進程部署時再切換 Postgres。SQLite 模式必須使用單一 writer queue 與 deployment lock。不可把資料庫實作細節洩漏到 Cordis command handler。

## 7. 安全與治理

候選 policy/tool 的 AST guard 至少拒絕：`eval`、`exec`、`compile`、`os.system`、未控管的 `subprocess`、任意 socket/network、未限制的 `open`、動態 import 與秘密環境變數讀取。AST 檢查不是完整隔離，仍必須在最小權限 sandbox 執行。

另需具備：

- allowlist imports、檔案路徑與工具權限。
- 每次任務的 CPU、記憶體、時間、網路與輸出大小上限。
- prompt injection 與 tool output 不得修改 policy、配置或權限。
- 高風險 action 預設要求人工核准。
- `embodied_act` 必須依 session、tool 與 action risk 檢查權限；危險 action 要求明確 confirmation，且預設只開放安全 primitive。
- backend 必須提供 timeout、取消與 emergency stop/disable hook；硬體整合需由 backend 自行完成 fail-safe。
- `embodied_act` 必須遵守狀態機：`REQUESTED -> AUTHORIZED -> EXECUTING -> COMPLETED|FAILED|CANCELLED|TIMEOUT|EMERGENCY_STOP`。
- 每個 action 必須有 lease、idempotency key、session-level mutex、rate limit；emergency stop 後禁止自動重試。
- 所有 embodied backend 必須宣告 capability profile；沒有宣告的 sensor、action、座標系或速度限制不得被呼叫。
- log redaction、資料保留期限與刪除機制。
- policy deployment audit trail。

AST guard 不是隔離措施。候選 policy、tool 與 evaluator 必須在最小權限、唯讀輸入、無秘密、受限網路的隔離 runner 執行；部署前需驗證 artifact checksum 與簽章。

## 8. 可觀測性

至少輸出以下 metrics：

- 任務成功率、最終品質、重試率與 boundary miss rate。
- 每 task 的 DeepSeek token、費用估算、LLM latency、tool latency。
- policy 版本的 Q/C/P/M、通過比例與 canary 結果。
- replay hit ratio、候選數、拒絕原因與 rollback 次數。
- Embodied loop 的 observation/action/result 延遲與 action failure rate。

log 必須可用 `taskId`、`policyVersion`、`evaluationId` 與 `correlationId` 串聯。Metrics 不應依賴完整 prompt 或秘密內容。

## 9. 建議目錄結構

建議拆分為兩個可獨立測試與部署的 capability：`dream-rsi-core` 負責探索策略生命週期，`dsh-embodied` 負責感知/行動 backend。兩者透過 Cordis service、typed event 與通用 action schema 連接。沒有 embodied backend 時，core 仍必須可正常運作。

```text
deepseek_dream_rsi/
  index.ts                  # Cordis apply(ctx, config)
  config.ts                 # schema 與預設值
  adapter/
    deepseek.ts             # Harness LLM adapter
    cordis.ts               # Cordis API 相容層
    environment.ts          # Embodied Environment adapter
    embodied-backend.ts     # per-session backend facade
  runtime/
    task-runner.ts
    action-loop.ts
  discovery/
    models.ts
    repository.ts
    sqlite-repository.ts
  replay/
    snapshot.ts
    simulator.ts
  evolution/
    candidate-generator.ts
    evaluator.ts
    evolution-loop.ts
  guardrails/
    ast-guard.ts
    resource-guard.ts
    monotonic-gate.ts
  tools/
    registry.ts
    synthesizer.ts
    embodied.ts             # perceive / act / query_state
  deployment/
    version-manager.ts
    canary.ts
    rollback.ts
  commands/
    dream.ts
  metrics/
  tests/
```

Embodied capability 可使用獨立 package 或同一 monorepo package：

```text
dsh-embodied/
  manifest.json              # DSH plugin manifest
  index.ts                   # tools/events/services registration
  backend/
    simulator.ts
    session-context.ts
  tools/
    perceive.ts
    act.ts
    query-state.ts
  safety/
    capability-profile.ts
    action-state-machine.ts
  tests/
```

若既有 DeepSeek Harness 是 Python 實作，保留相同模組與接口語意，將 Cordis adapter 放在邊界；不要為了目錄名稱強行混合兩套 runtime。

## 10. 配置要求

```yaml
model:
  provider: deepseek
  name: deepseek-chat
  timeout_ms: 60000
  max_retries: 2
  api_version: pinned

storage:
  url: sqlite:///data/discovery.db
  artifact_dir: data/artifacts

runtime:
  max_workers: 4
  task_timeout_ms: 300000
  require_approval_for_high_risk_actions: true

replay:
  max_nodes: 10000
  miss_rate_max: 0.05
  key_schema_version: 1
  require_counterfactuals: true

evaluation:
  train_ratio: 0.70
  validation_ratio: 0.15
  holdout_ratio: 0.15
  minimum_holdout_samples: 20
  confidence_level: 0.95
  evaluator_isolation: required

operations:
  evolution_lock: data/locks/evolution.lock
  deployment_lock: data/locks/deployment.lock
  job_lease_ms: 300000
  writer_mode: single

evolution:
  enabled: false
  max_candidates: 8
  auto_deploy: false
  minimum_improvement: 0.01
  monotonic_pass_ratio: 0.95

rollback:
  stable_versions: 3
  error_rate_threshold: 0.20

embodied:
  enabled: false
  backend: simulator
  require_action_confirmation: true
  allow_actions: [move_relative, goto, pick, place, open]
  observation_artifact_threshold_bytes: 65536
  action_lease_ms: 30000
  max_actions_per_minute: 30
  emergency_stop_on_timeout: true
```

## 11. MVP 實作順序

1. Cordis plugin lifecycle、profile/patch 掛載、manifest/config schema、權限與 `dream status`。
2. DeepSeek/Harness adapter、既有 agent loop 整合與最小 task/action loop。
3. Embodied backend、per-session state、capability profile 與 `perceive/act/query_state` tools/events。
4. SQLite Discovery Repository、單一 writer lock 與不可變 replay snapshot。
5. ReplayKey、counterfactual Replay Simulator、Evaluator 與可重現測試。
6. train/validation/holdout split 與隔離 evaluator。
7. AST/resource guard、evaluate-only evolution 與簽章報告。
8. Monotonic Gate、版本管理、人工核准與 rollback。
9. Tool Registry；最後才加入 Tool Synthesizer。
10. canary metrics、Web UI/trace 可視化與 action state machine。
11. 在多個 task family 上調整權重，避免直接拿單一任務的最佳 policy 宣稱跨任務泛化。

## 12. 驗收標準

- `apply(ctx, config)` 可在 Cordis 啟動與正常 dispose，設定錯誤會明確失敗。
- 一個端到端任務能產生完整 DAG，並以 correlation id 查回。
- Replay 執行期間 DeepSeek 呼叫數為 0，外部 sandbox/tool 執行數為 0。
- 相同 snapshot、policy 與 seed 的評估結果一致，浮點差異小於 `1e-6`。
- 候選 policy/tool 對禁用 API、未授權 import、資源超限會被拒絕。
- 品質劣化或未達 95% 歷史案例門檻的候選永不部署。
- deployment、approval、rollback 均有 audit event。
- 線上 current policy 與離線 evolution worker 隔離；evolution 故障不會中斷任務服務。
- 停用工具後，任何新任務都不會再選到該工具。
- DSH session 能看見 `embodied_perceive`、`embodied_act`、`embodied_query_state`，且每個 tool call 都能對應到 session 與 episode trace。
- `embodied_act` 的開始、完成、錯誤事件可被其他 Cordis plugin 訂閱；action timeout 或拒絕不會留下未完成 worker。
- 透過 profile 或 `cordis.patch.yml` 載入與卸載 plugin 後，所有註冊項目都能可逆清理。
- evaluator 與 holdout 資料在候選程式隔離環境中執行；候選無法修改評估器或偽造成本/品質結果。
- ReplayKey 能區分相同 state 下的不同 action，並能產生可重現的 counterfactual branch。
- action state machine 能正確處理 authorization、timeout、cancel、emergency stop 與禁止重試。
- 多 worker 同時要求 evolve/deploy 時，只有一個 job 取得 lock，其餘 job 能排隊或明確失敗。
- observation artifact 具備 schema version、timestamp、座標系、checksum、retention 與刪除流程。
- metrics 可區分模型成本、工具成本、回放成本與真實環境成本。

## 13. 待確認決策

1. 目前使用的 Cordis 版本與 plugin API 是哪一套？需以實際版本補齊 adapter 方法名。
2. DeepSeek Harness 是現有服務、Python library，或需要一併建立？
3. 第一個 benchmark task 是程式碼修復、GPU kernel、數學搜尋，還是數位 embodied environment？建議先選 simulator，避免 MVP 綁定硬體。
4. 自動部署是否永遠需要人工核准？建議 production 預設需要。
5. 成本貨幣、品質函數與 action risk 分級由哪個上游系統提供？
6. Discovery DAG 是否包含敏感資料？需先決定 retention、加密與 artifact store。
7. DSH 實際 plugin manifest、`ctx.tools`、`ctx.events` 與 `ctx.services` API 版本，需依官方 SDK 校準 adapter。
8. simulator 的 observation schema、座標系、action capability profile 與第一批 task family 需先固定。

## 14. 實作建議

- 先交付「可回放、可評估、不可自動部署」的垂直切片，驗證資料模型與評分可重現性後再開啟 Evolution Agent。
- 將 policy candidate 當作不可信程式碼處理；AST guard 只作第一層，不能替代作業系統級 sandbox。
- 用多個彼此不同的 benchmark task 做 gate，避免 policy 只記住單一 Discovery DAG。
- 把 `Q`、`C`、`P`、`M` 與總分全部呈現給管理者，避免單一分數掩蓋成本或安全退化。
- 建立 shadow/canary 模式，先觀察新 policy，再允許熱替換。
- 只有在工具 schema、測試、權限與回滾機制成熟後，才開啟自動工具合成。
- 先以 simulator backend 驗證 observation/action/event 契約，再考慮 ROS、Isaac Sim 或其他硬體/模擬器 adapter。
- 使用 DSH tracing 與 storage plugin 保存 episode artifact，避免將完整影像或 point cloud 塞進 LLM context。
- 固定 DSH SDK、plugin manifest、Cordis patch 與 profile 的相容性測試，因 requirement3 指出目前仍可能處於 developer preview。
- 對每個 task family 建立成功、劣化、boundary miss、timeout、取消與安全拒絕的 benchmark fixture。
- 為 observation artifact 建立 schema version、checksum、加密、retention 與個資遮罩規則。
