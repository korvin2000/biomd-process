Translate the Markdown document supplied below.

- Source language: **<%= it.sourceLanguage %>**
- Target language: **<%= it.targetLanguage %>**
<%_ if (it.glossary && Object.keys(it.glossary).length) { _%>
- Use these renderings consistently:
<%_ Object.entries(it.glossary).forEach(function (entry) { _%>
  - `<%= entry[0] %>` → `<%= entry[1] %>`
<%_ }); _%>
<%_ } _%>
<%_ if (it.partial) { _%>
- You are translating **part** of the document (<%= it.partLabel %>). Translate
  exactly this fragment; do not add an introduction or a conclusion, and do not
  close blocks that were opened before it.
<%_ } _%>

Return the translated document only.
