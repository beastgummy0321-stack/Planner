# Planner 3.0 最佳化報告

日期：2026-09-16。基準：01b1a09b85c1c5b43e86bec213056458973577c1（2.9.1）。修改在本機 checkout，尚未提交、推送或安裝到使用中的 plugin cache。

## 設計依據

依據 [OpenAI：Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)，把技能觸發條件、必要上下文、授權與完成條件寫清楚，讓流程負擔與任務相稱。這是設計依據，不能代替實際任務評測。

## 問題與實際修改

| 問題 | 修改與保留的邊界 |
|---|---|
| 僅有 Claude plugin metadata | 新增 Codex manifest；保留 Claude manifest，共用 skills 與 hooks。 |
| 固定 Claude 模型／effort | 移除角色模型綁定，繼承使用者或主代理選定模型。 |
| Claude Agent/工具名稱假設 | 新增 host 正規化；支援 exec_command、apply_patch、spawn_agent；patch 檢查每個路徑與搬移目的地。 |
| Claude 自動 worktree 假設 | 提供獨立 worktree CLI；Codex native worker 需明確 attach。角色本文共用，不假裝 Claude metadata 會註冊成 Codex agent。 |
| 小任務也強迫全流程 | 共用 WORKFLOW 明確區分直接處理與 Feature/Issue queue。 |
| 討論／原型先初始化 Git | dig/demo 不以初始化 queue 或架構盤點為前置。 |
| 無關架構／歷史／原型強制讀取 | 按當前決策讀取；attach 只提供相關原型；status 限制摘要長度。 |
| 七個 skill 重複流程約束 | 共通規則集中 WORKFLOW；各 skill 保留自身輸入、行為與完成條件。 |
| 已授權卻再等使用者一句話 | authorize 記錄既有實際授權；claim 不再依賴「計畫後有新訊息」的時間推論。 |
| 任意新訊息可被當授權 | prompt hook 不授權；revoke 撤回；Outcome 改變使既有授權失效。 |
| 頻繁要求 planner/challenger/utility | 按風險及效益使用；簡單規劃／短錯誤可由 Main 處理。 |
| 不必要獨立審查 | 重大介面、所有權等仍保留 review；移除整合完成後一律再做 planner review 的指令。 |
| 重複驗證 | 同一次 finish/integrate 內相同命令只執行一次；不同合併狀態的必要驗證保留。 |
| 測試不可改／一律 mutation | 允許依已核准行為更新測試；mutation 按風險選用，禁止掩蓋缺陷。 |
| 一次普通紅燈就丟棄工作樹 | 保留 worktree 與完整錯誤 log 供修復；越界與真正外部阻塞仍 block。 |
| 重試只看問題票，忽略原始碼已變 | 重試 fingerprint 納入來源狀態。 |
| hook 內安裝依賴造成等待／逾時 | hook 僅檢查準備狀態；env CLI 執行安裝，依 manifest/lockfile 指紋快取。 |
| 複合命令未識別 runtime | 支援命令分隔符後的 runtime；簡單 builtin probe 不觸發安裝。 |
| scripts 變動等同新增套件 | deps 允許空陣列，仍要求明確宣告；依賴／介面問題票獨占排程。 |
| 新 session 自動回收其他執行者 | recover 預設不動作；必須提供已確認結束的 session。 |
| Main 寫入與 worker snapshot 競爭 | worker 命令進行中拒絕 Main source 編輯及控制面的整合動作；控制文件更新仍允許。 |
| finish 後內容改變仍能 merge | merge 確認 HEAD 與乾淨工作樹，review receipt 綁定 head。 |
| close 可跳過驗收 | 需要新的成功整合 receipt，綁定來源、HEAD、feature 和 queue；人工項目另需實際接受。 |
| close 清理其他 feature 的 scratch | 保留 scratch，留待明確範圍清理；先完成分支整合，再刪除已完成文件。 |
| 驗證命令無等待上限 | 增加可配置的 shell timeout；長期 server 必須自行 readiness/cleanup，未宣稱完整 process-tree supervisor。 |
| 全域文件過度集中產品細節 | 建立簡短的 ~/.codex/AGENTS.md：使用者偏好、按需閱讀、風險分級與誠實驗證；產品資料仍在專案。 |

## 保留而未放寬

- 敏感操作、正式環境、付費、發布／推送、秘密與破壞使用者資料的授權邊界。
- worker touch/do_not_touch、worktree 範圍、必要架構檢查、整合 smoke、人工驗收。
- 所有權 analyzer 對動態且不可證明的目標仍保守失敗；本次未把 unknown 改成 green，也未重寫 analyzer。
- 不支援的 analyzer 明確 skipped。Hooks 和 Git diff 不是 OS sandbox；授權紀錄是協調者如實記錄，不是身分驗證。
- 每個 queue 仍以一個協調者為前提；未新增跨程序 scheduler lock。其他 session 不可擅自接管。

## 相容性證據邊界

CLI/worktree/合成 hook payload 有自動測試；Codex manifest 和七個 skill 有 validator 驗證。尚未在兩個宿主中安裝後做完整 native agent/hook 端到端測試。因此本次完成的是共用規則、封裝和執行相容層，不是宣稱所有 LLM 平台都經過實測。

全域設定位置：`C:/Users/User/.codex/AGENTS.md`（官方檔名為 AGENTS.md，非 agent.md）。它只設定 Codex；沒有修改 Claude 的全域 CLAUDE.md。Claude 透過 plugin 共用 WORKFLOW。新工作階段會重新載入全域指令。

## 已執行驗證

- `npm test`：40 / 40 通過（Node CLI、Git lifecycle、TS/Python adapter 與合成 hooks）；不是宿主端到端證明。
- Codex plugin validator：通過；7 / 7 SKILL quick validator：通過。validator 使用暫存目錄中的 PyYAML，未修改全域 Python 套件。
- `git diff --check`：通過。
- 七份 skills 加五份角色本文：51,148 → 16,678 字元；新增共用 WORKFLOW 4,302 字元，合計 20,980，比原先少約 59%。這是文字量差異，不是 token 或速度實測。
