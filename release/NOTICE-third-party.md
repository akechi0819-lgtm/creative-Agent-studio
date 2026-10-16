# 第三方组件与模型 NOTICE

本文件记录随包实际存在的重点许可证义务和定位路径，不构成法律意见或“全部许可已获批准”的结论。逐包版本、声明许可证、安装路径及识别到的许可证文件见包内 `THIRD-PARTY-LICENSES.json`。打包器会保留包内 `LICENSE`、`NOTICE` 与 `licenses/` 文件，并要求本文件列出的静态许可文本存在；缺失时阻止生成正式 Release 归档。

## MPL-2.0

- `@deepseek-ai/libreoffice-kit@0.1.5` 与对应原生 `@deepseek-ai/libreoffice-kit-<平台>@0.1.5` 声明 MPL-2.0。保留包内 `LICENSE`、`NOTICE`、原生包 `licenses/LibreOffice-MPL-2.0.txt`、`licenses/LibreOffice-third-party.html`，以及嵌入式 LibreOffice 的 `program/LibreOfficeDev.app/Contents/Resources/LICENSE` 和 `NOTICE`（这些在归档内原路径）。
- 上游源代码入口：[DeepSeek LibreOffice Kit](https://github.com/deepseek-ai/dsh-libreoffice-kit)，具体 npm 版本为 0.1.5。静态 MPL 文本另见 `release/licenses/MPL-2.0.txt`。
- 本项目不修改上述上游包。若将来修改 MPL 覆盖代码，必须随正式分发提供对应修改的源代码；打包器不会替代这一义务。
- 若生产依赖清理后仍包含 `lightningcss@1.32.0`，其自身 `LICENSE` 也随包保留；其为前端构建依赖，通常在 `npm prune --omit=dev` 后不会进入运行包。

## LGPL-3.0-or-later：sharp/libvips

- `@img/sharp-libvips-<平台>@1.3.4` 声明 LGPL-3.0-or-later；随包保留其 `README.md`、`versions.json` 和 `lib/` 中的本平台动态库。`README.md` 列出其依赖组件和许可证，`versions.json` 记录实际组件版本。macOS 包中的 `lib/libvips-cpp.8.18.7.dylib` 以独立文件保留，未静态合并或改写；Windows 及另一 Mac 架构以各自 runner 产出的文件为准。用户可替换相同 ABI 的动态库文件。打包器会拒绝缺少动态库、README 或版本清单的目标包。
- 入口：[sharp-libvips 源码与构建仓库](https://github.com/lovell/sharp-libvips)、[sharp 安装说明](https://sharp.pixelplumbing.com/install/)。随包 `README.md` 的许可证表、`versions.json` 及 `THIRD-PARTY-LICENSES.json` 的包路径共同给出确切版本；具体 LGPL 组件以每个平台自身清单为准。LGPL-3.0 文本随包位于 `release/licenses/LGPL-3.0.txt`。
- 如果未来改为静态链接、合并动态库、修改库代码，或无法提供上述相应版本的源代码获取入口，应暂停正式发布并重新核对义务。

## CC-BY-4.0：caniuse-lite

- `caniuse-lite@1.0.30001791` 的数据采用 CC BY 4.0。随包保留其原始 `LICENSE`（当该包进入最终依赖时），并在此注明：数据来源为 **Can I Use / caniuse.com**，上游项目要求将来源标为 caniuse.com。静态许可证文本为 `release/licenses/CC-BY-4.0.txt`。
- 上游说明：[browserslist/caniuse-lite README](https://github.com/browserslist/caniuse-lite#license)。若生产依赖裁剪后该包不在归档内，本条仍保留作构建依赖来源记录。

## Node.js 与 Python

- Node.js v22.23.3 是各平台官方归档，保留解压后的 Node 根目录 `LICENSE`；路径写入 `THIRD-PARTY-LICENSES.json` 和 `release-manifest.json`。上游：[Node.js v22.23.3](https://nodejs.org/dist/v22.23.3/)。
- Python 3.12.15 为项目私有随包运行时。打包器要求在运行时目录找到 `LICENSE` 或 `LICENSE.txt`；各 Python 分发包的许可证字段、`*.dist-info/licenses/` 路径写入清单。锁定依赖由 `scripts/requirements-cleaner-ocr.lock.txt` 和 `scripts/requirements-workspace.lock.txt` 固定。

## RapidOCR / PaddleOCR 模型

- OCR 运行时使用 RapidOCR 预先生成的 ONNX 模型，随包模型位于 `.studio-runtime/rapidocr-models/`；模型来源、版权归属、SHA-256 与许可声明见 `release/NOTICE-rapidocr-models.md`。RapidOCR 的官方模型许可说明分别记录项目代码与模型权利人，包内继续提供该声明。
- RapidOCR Python 包及其依赖许可证由 `THIRD-PARTY-LICENSES.json` 的 Python 分发包记录和对应 `*.dist-info/licenses/` 路径定位。上游模型许可说明：[RapidOCR Model License and Attribution Statement](https://rapidai.github.io/RapidOCRDocs/main/en/model_licenses/)。

## Tesseract.js 语言模型

- 随 Node 包的 `@tesseract.js-data/eng@1.0.0` 和 `@tesseract.js-data/chi_sim@1.0.0` 的 npm 元数据声明 MIT；包内原始 `package.json` 会保留该声明。数据仓库说明 `4.0.0_best_int` 语言模型来自 `naptha/tessdata`，其上游提供 Apache-2.0 许可证；因此随包提供 `release/licenses/Apache-2.0.txt`。这两个数据包只包含 README、包元数据和模型文件，没有单独的 MIT 许可证文本；这里不把 npm 元数据声明误当作模型上游许可证，也不与 `tesseract.js` 引擎许可证混为一谈。模型文件位于包内相应 `node_modules/@tesseract.js-data/*/4.0.0_best_int/`。
- 来源：[naptha/tessdata 模型说明](https://github.com/naptha/tessdata/blob/gh-pages/README.md)、[naptha/tessdata Apache-2.0 LICENSE](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE)、[Tesseract tessdata 上游](https://github.com/tesseract-ocr/tessdata)。引擎本身使用其 npm 包声明的许可证，路径列于 JSON 清单。
