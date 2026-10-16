# RapidOCR 模型归属与再分发说明

本运行包的 `.studio-runtime/rapidocr-models/` 包含 RapidOCR 使用的 ONNX OCR 模型文件。模型权利归属为 Baidu 和／或相关 PaddleOCR 权利人；依据 RapidOCR 官方模型许可与归属说明，此处涵盖的模型制品按 Apache License 2.0 分发。模型由上游转换为当前推理格式；本项目打包过程不修改模型文件，并在 `release-manifest.json` 中记录每个文件的 SHA-256。

RapidOCR 源码及 Python 组件的许可证和随包 NOTICE 文件保留在 `.venv-ocr/` 的发行元数据中。上游模型来源、锁定版本与准备方式见 [清洗脚本来源](../docs/清洗脚本来源.md)；模型归属和再分发要求见 [RapidOCR 官方说明](https://rapidai.github.io/RapidOCRDocs/main/en/model_licenses/)。Creative Agent Studio 不代表 Baidu、PaddlePaddle 或 RapidOCR 获得背书或关联授权。
