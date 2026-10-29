# 文档导航

## Company Lite 当前说明

- [产品简介与源码快速开始](../README.md)
- [当前产品范围](../Creative_Agent_Studio_PRD.md)
- [开发与施工计划](../开发与施工计划.md)
- [工程进度与验证边界](工程进度.md)
- [宿主智能体使用流程](代理宿主使用.md)
- [创作 Skill](../.agents/skills/creative-studio/SKILL.md)

以上文件描述 `codex/company-lite`。后续实现变化先更新这里的当前说明。

## 旧版历史证据

本目录保留的 P0—P5、P3／P4、旧运行与分发流程、Canvas、素材、DNA、模型来源与本地 Web 报告，均是旧版本或特定任务的历史证据。它们可用于追溯历史实现和当时的验收边界，**仅适用于对应旧版与报告所列提交**；不得据此推断 Company Lite 当前源码、具体宿主登录、Teedy 账号权限或目标系统已验证。旧分发路径不代表当前产品要求。

旧版操作指南也不再作为本分支员工步骤。当前产品边界、操作方式与状态分别以本页上方链接的 PRD、代理宿主使用和工程进度为准。未修改原历史报告，保留其当时表述与证据。

## 宿主入口

在宿主中打开克隆后的 Company Lite 仓库根目录，再使用[入口说明](../.agents/skills/creative-studio/references/host-entry.md)要求智能体显式读取项目规则和 Skill。本仓库不依赖宿主自动发现 Skill，也不假设特定客户端的 MCP 配置格式。
