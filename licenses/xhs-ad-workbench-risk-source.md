# 公司版风险词库来源

`src/company/risk.mjs` 以只读方式迁移自 `RAG-Yuki/xhs-ad-workbench/content/risk-review.mjs` 的词项匹配与多分类合并逻辑。源项目在固定上游 `EthanYoQ/agent-xiaohongshu-workbench` 提交 `6e58278984cb891524ead60c9a5f116b6561b4cc` 上按 MIT 分发；许可文本见本目录的 `xhs-ad-workbench-MIT.txt`。

`src/company/risk-lexicon.json` 保留源公开工作台随包分发的 990 条记录和 985 个不同词项。源项目记录该词库由用户提供的 HTML 静态提取，运行时不依赖原 HTML。原条目的类别、风险等级、说明、建议和来源索引作为人工复核提示保留；条目内引用的法条或建议未经本项目核验，也不会自动修改文案或批准制作单。
