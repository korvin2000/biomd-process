Translate the <%= it.count %> text fragment(s) supplied below.

- Source language: **<%= it.sourceLanguage %>**
- Target language: **<%= it.targetLanguage %>**
<%_ if (it.glossary && Object.keys(it.glossary).length) { _%>
- Use these renderings consistently:
<%_ Object.entries(it.glossary).forEach(function (entry) { _%>
  - `<%= entry[0] %>` → `<%= entry[1] %>`
<%_ }); _%>
<%_ } _%>

Return one JSON object with the same keys and nothing else.
