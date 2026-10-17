# RapidOCR 模型归属与再分发说明

主 Release ZIP 不包含 RapidOCR ONNX 模型。首次启动的 Python/OCR 准备步骤会把模型缓存下载到用户数据目录的 `.studio-runtime/rapidocr-models/`，该目录不属于随 ZIP 分发的文件清单。

模型权利归属为 Baidu 和／或相关 PaddleOCR 权利人；RapidOCR 官方模型许可说明将相关模型制品按 Apache License 2.0 处理。上游模型来源与许可入口：[RapidOCR Model License and Attribution Statement](https://rapidai.github.io/RapidOCRDocs/main/en/model_licenses/)、[RapidOCR 项目](https://github.com/RapidAI/RapidOCR)。依赖版本由包内 OCR 锁文件固定；下载的本地模型由上游提供，本项目不修改模型文件。Creative Agent Studio 不代表 Baidu、PaddlePaddle 或 RapidOCR 获得背书或关联授权。
