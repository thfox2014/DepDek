# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，版本号由 `VERSION` 与 `npm run version:bump` 统一管理。

## [0.2.0] - 2026-09-27

- AI-OS 主页面新增「打开 DepDek 工作台」按钮，可跳转到 Mac 版 DepDekHome 主页面。
- AI-OS 主页面直接读取已配置的 provider model 与 agent 配置，不再要求现场填写连接。
- 主页面显示应用版本号。
- 引入版本管理：VERSION 单一来源 + npm run version:bump / version:check + CHANGELOG。
