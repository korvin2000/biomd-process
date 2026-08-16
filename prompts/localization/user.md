Localize the <%= it.count %> field value(s) supplied below.

- Source language: **<%= it.sourceLanguage %>**
- Target language: **<%= it.targetLanguage %>**
<% if (it.glossary && Object.keys(it.glossary).length) { %>- Use these renderings consistently:
<% Object.entries(it.glossary).forEach(function (entry) { %>  - `<%= entry[0] %>` → `<%= entry[1] %>`
<% }); } %>
Return one JSON object with the same keys and nothing else.
