Localize the <%= it.count %> field value(s) supplied below.

- Source language: **<%= it.sourceLanguageName %>**
- Target language: **<%= it.targetLanguageName %>**
- A value already written in <%= it.targetLanguageName %>,
  and a title or a name that is not conventionally translated, comes back
  unchanged.
<% if (it.glossary && Object.keys(it.glossary).length) { %>- Use these renderings consistently:
<% Object.entries(it.glossary).forEach(function (entry) { %>  - `<%= entry[0] %>` → `<%= entry[1] %>`
<% }); } %>
Return one JSON object with the same keys and nothing else.
