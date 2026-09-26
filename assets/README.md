# Personal resume template setup / 个人简历模板设置

`cv-template.docx` is a private input, not a generated output. It is intentionally
ignored by Git. This file keeps `assets/` present in a fresh checkout; no personal
template is distributed. Prepare the template once from your own confirmed CV,
then revalidate it whenever its content or the CV changes.

`cv-template.docx` 是用户私有输入，不是生成产物，因此不纳入 Git。此说明保留
`assets/` 目录。首次使用时根据本人已确认的 CV 准备模板；修改模板或 CV 后重新校验。

## Prepare / 准备

1. Finish Career-Ops onboarding first. For a non-sibling installation, export
   `CAREER_OPS_ROOT` as the absolute path to that checkout. Setup-check and all
   resume commands use the same value. Do not copy fictional examples into your CV.
   先完成 Career-Ops 资料设置。非同级安装须将 `CAREER_OPS_ROOT` 设为该仓库的绝对路径；
   检查与简历命令共用此值。不要将虚构示例当成个人经历。
2. Use your existing one-page Word resume if compatible, or ask your document agent
   to create a flat-paragraph DOCX from your confirmed facts. Preserve an existing
   template; work on a separate copy when adapting it. No tables, text boxes or
   content controls are supported. Use readable fonts, ordinary page margins and
   enough space to keep the baseline to one page.
   使用已有的一页 Word 简历，或让文档代理根据真实资料创建纯段落 DOCX。保留原件，
   调整时使用副本。当前不支持表格、文本框、内容控件；保证字号可读、页边距合理。
3. Keep exactly these four section headings in this order:
   `PROFESSIONAL SUMMARY`, `PROFESSIONAL EXPERIENCE`, `TECHNICAL SKILLS`, `EDUCATION`.
   Put exactly one summary paragraph before the experience section. Place your own
   name/contact paragraphs before the first section and education after the last.
   The summary, contact and education must be reviewed against your actual facts;
   the structural checker does not prove their factual correctness.
   保留上述四个英文标题及顺序；Summary 只有一段。姓名和联系方式放在首个标题前，
   教育信息放在最后一个标题后。这些内容仍需核对真实资料，结构校验不能证明真实性。
4. Include every role from `cv.md` in its original order. Each role heading must
   match the text after `### ` exactly; put any dates in that source heading too.
   Select at least one exact CV bullet per role; do not rewrite baseline bullets.
   Use real Word list paragraphs, not a typed bullet character. For the document
   agent: experience bullets must have direct `w:numPr` with `w:numId w:val="1"`
   and a matching numbering definition. This is the current renderer's contract.
   每段经历的顺序和标题须与 `cv.md` 一致，每段至少选一条原文 bullet。日期也应在来源
   标题中。使用真正的 Word 项目列表；文档代理须按上述编号约定生成，不能只输入圆点。
5. Include at least two skill paragraphs formatted as `Category: item, item`.
   Every item must match a skill in `cv.md`. Avoid blank paragraphs between the
   role groups, skills rows and section headings; use paragraph spacing instead.
   技能至少两行，条目须与 CV 完全匹配。经历、技能和章节之间使用段落间距，不插入空段落。
6. Save the reviewed personal template as `assets/cv-template.docx`, only if that
   destination is absent or the user has requested its replacement. Run from the
   Job Discovery root:
   将核对后的本人模板保存到此路径；不覆盖未经授权的已有模板。从仓库根目录运行：

   ```bash
   mkdir -p assets .tmp
   npm run resume:template
   ```

   To inspect another file before installing it, use
   `npm run resume:template -- /absolute/path/to/template.docx`.
   想先检查其他文件，可通过此参数传入模板路径，不必先覆盖已有模板。

## Acceptance / 验收

The command checks role/bullet/skill alignment and uses the existing Word page
counter and page-fit gate. It does not modify the template, candidate files or
application state. Word counting uses a temporary copy and removes it afterward.
`PAGE_COUNT: NOT RUN` means only the estimator was used, not Word verification.
An error must be resolved in the source template or confirmed CV formatting,
without inventing facts or disabling validation.

命令检查经历与技能匹配，并复用 Word 页数检查和排版估算；不修改模板或求职资料。
Word 检查会创建并清理临时副本。`NOT RUN` 只表示估算通过，不表示 Word 验证通过。
错误须通过修正模板或真实 CV 的格式解决，不能虚构事实或关闭校验。

Finally open the template in Word or render it with your document tool and inspect
every page for clipping, overlap and readable spacing. Confirm it is one page.
Only then use `resume:context` and `resume:build`. A user's template and visual
acceptance remain required; the repository does not claim one template fits every CV.

最后在 Word 中打开或使用文档工具渲染，逐页查看是否有截断、重叠及间距问题，确认
只有一页后再生成定制简历。每位用户都需要准备并验收自己的模板。
