# 招聘记录口径

仅在制作面试/求职流程图时读取。

## 来源与默认目录

先遵循各数据仓库的 `AGENTS.md`。Job Discovery 保存通用工具；Career-Ops 保存申请生命周期；Career Docs 保存唯一面试登记和个人材料。开源包不携带这些个人数据。

```text
workspace/
  job-discovery/                   本工具所在仓库，可改名
  career-ops/                      Career-Ops 代码及其路径解析接口
    data/applications.md          默认申请 tracker，实际路径由 Career-Ops 解析
    data/status-log.tsv           默认状态历史，与实际 tracker 同目录
  career-docs/                       私有文档工作区，可放在其他位置
    AGENTS.md
    context/00 Knowledge Base Hub.md
    context/Interview/
      active-interviews.md         唯一流程登记，含 Active 和 Archived
      <company>/                  对应的准备、复盘及证据链接
        process-summary.md        登记表 Notes 链接的身份、沟通和流程历史
    outputs/<snapshot>/           本次快照、事件摘录、JSON、图片；不发布
```

新用户缺少 Career Docs 时，使用仓库 `examples/career-docs/` 的空骨架（开发仓库对应 `release/overrides/examples/career-docs/`），不填入示例公司或流程。已有工作区不搬迁、不另建登记表。

| 数据 | 权威来源与读取方式 |
|---|---|
| 累计申请数量、当前申请状态 | Career-Ops `path-resolver.mjs` 定位 tracker；复用 `tracker-parse.mjs` 和 `stats.mjs` 的 `computeFunnelWithHistory`，不把 Evaluated/SKIP 当投递 |
| 历史曾到达阶段 | 实际 tracker 同目录的 `status-log.tsv`；缺失历史时只用现状，历史阶段数量为下界 |
| 面试流程身份、当前结果 | Career Docs 登记表的 Active + Archived；Tracker 列是精确关联，不能凭公司名匹配 |
| 已完成轮次和实际内容 | 登记表链接的流程汇总及其对应复盘、原始记录；准备、邀请和日历时间不证明完成 |

申请单位是 Career-Ops tracker 行，面试单位是独立招聘流程。两者不能直接相加或拿两张表总数相减计算“无回复”。默认分别画申请生命周期和面试流程；没有 tracker 关联的邀请仍在面试图中，不伪造一次投递。同流程换 requisition 不因标题相似而跨表合并。

## 路径适配与采集

从本仓库根运行（安装为 Skill 链接时先解析真实目录）。默认 sibling 路径由脚本真实位置推导，与调用时 cwd 无关；所有显式相对参数相对于调用 cwd：

```sh
node .agents/skills/process-infographic/scripts/collect.mjs \
  --career-ops ../career-ops --projects ../career-docs \
  --out ../career-docs/outputs/NEW-SNAPSHOT
```

`--career-ops` 指代码目录；数据根和 tracker 优先级委托 Career-Ops 自身的环境变量/marker/path-resolver。环境变量路径建议给绝对值，避免不同 Career-Ops 版本的相对路径差异。`--projects` 指私有文档根；`--interviews-file /actual/register.md` 覆盖默认登记位置。输出目录必须全新，脚本不改源文件。

如果只是文件夹布局不同，传绝对路径即可；如果登记格式也不同，先依据其真实字段编写一次性只读转换代码，生成私有 `--register-json /path/adapted.json`，替代 Markdown 登记输入：

```json
{"processes":[{"identity":"process-example-a","tracker":"","company":"Example Co","role":"Engineer","status":"Waiting","sources":[{"path":"original-register.csv","sha256":"<original-file-sha256>"}]}]}
```

来源路径相对于 adapted JSON。每条保留原始稳定身份；只有确切关联才填 `tracker:"#N"`。状态映射为 `Action Required / Scheduled / Waiting / Rejected / Withdrawn / Cancelled / Hired`；含糊状态必须先核实，不能凭相似文本强制映射。转换代码必须完整遍历原始记录并检查输入/输出身份集合，不能手填公司名单和人数。采集器验证唯一身份、状态、关联及来源校验值；格式适配不授权修改用户原始结构。

## 完成事件与动态分类

采集器每次重读申请和面试状态，重新计算人数与分组。自然语言复盘不能可靠地靠关键词确定轮次；先按下面口径审阅有关记录，生成私有 `events.json`，再传 `--events /path/events.json`。未提供完成证据的流程仍计入总数，显示 `Completion unclassified`，不当成零次面试。

```json
{"events":[{"id":"example-session-1","identity":"process-example-a","date":"2000-01-02","kind":"coding","sources":[{"path":"debrief.md","sha256":"<reviewed-file-sha256>"}]}]}
```

每个事件是一项已完成事实，不带人数或当前结果。`id` 稳定且唯一；`identity` 必须存在于本次登记；日期按来源时区保留场次日期，同日事件按数组顺序；来源路径相对于 events JSON。SHA-256 由代码读取真实文件计算，文件改变时重新审阅后提取，不能只更新 hash 跳过审阅。可用 `node --input-type=module -e 'import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' /path/to/evidence`。

支持事件类型：`screen / coding / debugging / integration / oa / ai-screening / design / hm / bq / loop / verbal-offer / verbal-accepted / written-offer / signed-offer`。其中 coding/debugging/integration 自动累计为实作场次。每次更新图表时先沿当前登记的 Notes 链接检查流程汇总里新的完成里程碑与有关复盘，补充新的事件；来源 hash 只能检测已有文件变化，不能证明遗漏的新文件不存在。当前结果始终来自本次登记，不从事件摘录缓存读取；原因和详细结果只有被当前证据支持才添加展示说明。

`snapshot.json` 保存真实路径、读取时间、来源 hash、逐条记录、分类和关联统计。默认 chart JSON 由这些记录生成，节点数量、分支、流宽和布局高度都自动计算；空数据不伪造节点，超大图要求按明确范围拆图。保留该快照，下一次重采集写新目录，不把快照当权威登记。

## 事实口径

- 入口写明是申请、招聘接触/邀请，还是已完成 HR screen。直接 OA 邀请可归入“招聘邀请”，但不能算一次已完成 HR 通话。记录表若不覆盖全部历史申请/联系，图中说明范围。
- “technical interview”或打开 HackerRank 不一定有 coding；按实际内容区分 coding、debugging、系统设计、项目深挖、HM、BQ、OA、AI screening。
- 用户需要逐轮 coding 时，可把现场编程、debugging、integration 等合为“实作”，但标明口径，OA 另外列出。只统计有完成证据的场次。
- “全部 coding 完成”“整个 onsite/loop 完成”不同。第二轮后拒绝不自动等于 final-round rejection；多轮安排在同一个 onsite 中，不代表每轮之间有通过决定。
- 岗位招满/取消、候选人退出、明确不支持签证分别于表现淘汰；原因未确认时只标已知结果。参考图有 Not Sponsor，不代表用户数据也有。
- 面试复盘的 No Hire/Mixed 是教练判断，不是公司的录用决定。收尾称赞不证明晋级。
- offer、口头接受、正式书面 offer、签署 offer 分开；申请表电子签名不能代替雇佣 offer 签署。
- 历史登记阶段与较新复盘不一致时，可以注明图表分类依据，不顺手修改登记表。最新已确认结果优先于旧复盘中的“结果未知”。

为每条流程保留：稳定身份、公司/岗位（私有）、完成事件和日期、结果及证据、图中节点路径。路径外的未知部分不补造；有邀请但无完成证据的流程仍要出现在完整图中。
