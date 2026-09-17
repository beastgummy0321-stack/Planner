# GPT-6 Astra：有／無 Planner 架構評分

> 2026-09-16 的歷史設計評估與當時 CLI 探測，非現行宿主能力宣告，也不是執行前置。只有重做 A/B 實驗才更新分數。

## 結論與證據等級

**在包含跨檔修改、相依工作與中斷續作的混合任務假設下，最佳化後 Planner 的架構評分較高：88 / 100；只有精簡全域規則、沒有 Planner 為 81 / 100。這是設計審查分數，不是 GPT-6 Astra 執行任務的實測成績。**

小型、清楚且可逆的任務，直接使用 Astra 已足夠。Planner 的價值主要在可恢復狀態、隔離與整合證據；本版讓小任務繞過 queue，所以不應為了得到「有 Planner」的標籤強迫建立問題票。

## 評分方法

以兩組具有相同全域 AGENTS、相同宿主權限與測試工具為前提。未使用 Planner 組仍會遵守使用者指示與執行測試，並非刻意設置弱基準。下列分數為本次單一審查者對結構的主觀評分，不能解讀為成功率、模型能力或具統計顯著性的差距。

| 維度 | 上限 | 無 Planner | 最佳化 Planner | 判斷依據 |
|---|---:|---:|---:|---|
| 完成條件與驗證證據 | 30 | 25 | 27 | 後者提供明確 issue/final receipt，但 live host 未證實。 |
| 比例合適、少讀少等 | 20 | 19 | 17 | 無 plugin 的固定負擔較低；後者仍有 metadata、狀態與命令成本。 |
| 授權與範圍控制 | 20 | 14 | 18 | 後者新增 lease、scope、revoke；兩者都仍依賴宿主權限。 |
| 中斷恢復與相依排程 | 15 | 10 | 14 | 後者具 queue、保留修復、明確回收條件。 |
| 移植性與維護成本 | 15 | 13 | 12 | 無 plugin 較單純；後者雙 manifest 和正規化改善相容性，但仍需宿主驗證。 |
| 合計 | 100 | 81 | 88 | 權重偏向多步軟體任務；改變任務組成可能改變排序。 |

## 本次真正執行的模型探測

呼叫本機 Codex CLI，以 `--ignore-user-config --skip-git-repo-check --ephemeral -m gpt-6-astra -s read-only --json` 在暫存目录執行只要求回覆 ASTRA_READY 的提示。服務端回覆 HTTP 400：

> The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.

因此 **沒有模型任務完成率、token、延遲、確認次數或 A/B 綜合成績可報告**。未用另一模型的結果冒充 Astra，也未擅自更新使用者的 Codex。CLI regression tests 證明的是 harness 行為，不是 LLM 效能。

## 可重現的後續 A/B 設計

1. 更新到支援 Astra 的宿主後，固定模型、reasoning effort、工具權限與全域指令。另在 Claude 做宿主相容性驗證。
2. 準備至少 12 個固定任務：4 個小型修改、4 個跨檔功能／缺陷、4 個需續作／依賴／敏感操作邊界的任務。每個有獨立驗收測試和預期允許行為。
3. 每題兩組使用同一乾淨 Git 基準；A 不載入 Planner，B 載入本版且允許 direct path。至少各跑 3 次，交錯順序。不得共用完成的解答或 session 記憶。
4. 記錄正確完成率、越權事件、使用者介入次數、無意義確認、工具呼叫、上下文字量、token、耗時、恢復成功率。核對真正載入了哪些指令。
5. 綜合成績：驗收 40%、範圍安全 25%、資源效率 20%、介入／恢復 15%；安全事件另獨立列出，不用速度抵銷。事先固定正規化基準，報告各任務類型、分布與失敗案例。
6. 只有完成實測後才能說哪組在這個任務集上執行成績較高；架構評分只支持目前採用「簡單任務直接做，複雜任務按需 Planner」的選擇。

設計來源：[OpenAI Astra skills/prompts 指引](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)。本文分数與權重均為本次自訂，非 OpenAI 官方評分。
