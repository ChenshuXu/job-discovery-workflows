# 渲染工具

招聘图先用 `scripts/collect.mjs` 从 Career-Ops 和 Career Docs 动态采集与构图；数据归属、默认目录及其他结构的适配见 [招聘记录口径](interview-records.md)。`scripts/build.py` 串联采集与渲染，输出申请和面试两部分，避免混淆两个计数单位。

依赖 Node.js（与本仓库一致）、Python 3 和 Pillow。不依赖某个宿主专用工具；已有 Pillow 环境可直接使用，否则创建自己的虚拟环境：

```sh
python3 -m venv /path/to/venv
/path/to/venv/bin/python -m pip install Pillow
/path/to/venv/bin/python .agents/skills/process-infographic/scripts/build.py \
  --career-ops /path/to/career-ops --projects /path/to/career-docs \
  --out /path/to/career-docs/outputs/NEW-SNAPSHOT --font /path/to/cjk-font.ttf
```

可传 `--interviews-file` 或 `--register-json` 适配登记位置/格式，传 `--events` 纳入已核实的完成事件，`--variant full|anonymous|both` 控制图片版本。生成 `snapshot.json`、两份 chart JSON 和 `applications/`、`interviews/` 下的图片。整目录是私有工作产物，即使只渲染 anonymous 也包含私有快照；对外只交付检查过的 PNG/SVG。某部分没有记录时不生成对应图，不能把缺少源文件当成零。

`scripts/render.py` 使用 Python 标准库和 Pillow，按同一份 JSON 生成具名及无名称的 PNG/SVG，无外部网络调用。它只负责渲染，直接调用时不会重新采集数据。其他业务或手工调整布局可用：

```sh
python /absolute/path/process-infographic/scripts/render.py /path/to/chart.json --out /path/to/output --font /path/to/cjk-font.ttf
```

默认输出 `process-full.png/svg` 和 `process-anonymous.png/svg`。`--variant full` 或 `--variant anonymous` 只输出一版。使用新建/本次拥有的输出目录；同名输出会覆盖。PNG 以两倍尺寸绘制后缩小，SVG 保留文本。字体默认尝试 macOS Arial Unicode 或 Linux DejaVu；中文应使用覆盖中文的实际字体并查看渲染。

## 最小输入（虚构数据）

```json
{
  "width": 1400, "height": 650, "unit": 28, "font_size": 26,
  "title": "示例流程 · 客户明细", "public_title": "示例流程",
  "subtitle": "截至某日 · 按独立流程计数", "public_subtitle": "截至某日 · 按独立流程计数",
  "footnotes": ["具名版来源说明"], "public_footnotes": ["完成不等于通过"],
  "sensitive_terms": ["Example Co", "REQ-EXAMPLE"],
  "nodes": [
    {"id":"start", "x":100, "y":260, "label":"招聘邀请", "public_label":"招聘邀请", "color":"#d96fba", "placement":"above"},
    {"id":"coding", "x":550, "y":260, "label":"Coding 完成", "public_label":"Coding 完成", "color":"#16a9b6", "placement":"above"},
    {"id":"wait", "x":980, "y":220, "label":"等结果", "public_label":"等结果", "details":["Example Co · REQ-EXAMPLE"], "public_details":[], "color":"#8b969e"},
    {"id":"rejected", "x":980, "y":390, "label":"首场后拒绝", "public_label":"首场后拒绝", "color":"#d66b69"}
  ],
  "records": [
    {"id":"private-process-a", "path":["start","coding","wait"], "sources":["private record A"]},
    {"id":"private-process-b", "path":["start","coding","rejected"], "sources":["private record B"]}
  ]
}
```

节点顺序用于渲染，端口按另一端的 y 位置排列。节点高为经过该节点的记录数 × `unit`；色带从源节点右侧连到目标左侧，颜色跟随目标。默认 `placement:right`，`above` 将标签放在节点上方。`details` 每项为一行；长行需主动拆分。颜色使用 `#RRGGBB`。

每条记录是一个统计单位，`id` 唯一，`path` 至少两节点，不重复经过同节点。若只有汇总数据，可加整数 `weight`，例如 5；必须明确这代表有来源的 5 个单位而非 1 条流程。不要靠 weight 修平无法解释的差额。

所有具名文字字段和公开文字字段分离；`public_title`、各节点 `public_label` 必填，无默认回退。`public_details`、`public_subtitle`、`public_footnotes` 可省略为空。`sensitive_terms` 是额外的已知标识检查，不替代人工审阅公开文字；输入 JSON、记录 ID、sources 不会嵌入输出。

脚本拒绝重复 ID、未知节点、无来源、非正权重、重复路径节点、不守恒的中间节点、从右向左的边和裁出画布的标签/节点。若某条记录在中间阶段停留，增加“等待/未知”末端，而非同时把同节点当中间和结束。

保存事实依据/分类说明和私有 chart JSON 在项目输出目录，技能目录只保留通用工具。技能的快速自检：

```sh
python /absolute/path/process-infographic/scripts/check.py
```
