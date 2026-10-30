# dsh-aionui-panel

[English](README.md) | 中文

> **已停用。** 本包不再挂载 AionUi 的 Explorer/Preview 列，也不再注册 `/aionui-panel/*` host 路由。右侧面板由外部插件 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 提供（需单独安装，未安装时设置卡片会显示不可用）。

## 当前仍运行的部分

- **Host**（`src/index.ts`）：`aionui-panel` 设置命名空间（可用性锚点）。已废弃的 `rightPanel` 字段仍被接受，以便旧的 `settings.yaml` 能通过校验；其值在任何地方都被忽略。`src/host/` **未被 import，也未注册**。
- **Client**（`src/client/`）：设置 → Web UI 插件 下的「侧边卡片」设置卡。输入框拖放与 transcript mermaid 哨兵仍注册，但没有面板列（`[data-aionui-preview-col]` 不会被创建）时它们是空操作。

安装本包或全家桶**不会**恢复 Explorer、Preview、fs/git HTTP 路由，也不会恢复提供方选择。更细的侧边卡片设置在 `~/.dsh/settings.yaml` 的 `dsh-better-sidebar` 命名空间。

## 结构（现行 / 历史）

- `src/index.ts` — 仅 host 设置命名空间。
- `src/client/AionUiSettingsCard.tsx` / `SideCardPrefs.tsx` — 现行侧边卡片。
- `src/host/` — 不受支持的历史实现（路由、工作区门禁、git 轮询）。文件夹内仍有相互引用，故未删除；`apply` 不会挂载它们。不要把其中注释当作现行行为。

## 历史记录（未挂载）

曾是 AionUi 右侧面板的像素级复刻（Apache-2.0 参考实现，非抄录）：Explorer + Preview + `/aionui-panel/*` loopback 围栏路由。提供方选择删除后，这条路径已从 `apply` 移除。全家桶仍插入本包行，只为保留设置卡；后续版本可能去掉该行。

## 署名

尺寸、颜色、交互参数来自对 AionUi v2.1.53（iOfficeAI/AionUi，Apache-2.0）的实测。实现为新代码。上游版权归 AionUi 项目。
