Translate the Markdown document supplied below.

- Source language: **<%= it.sourceLanguageName %>**
- Target language: **<%= it.targetLanguageName %>**
<% if (it.glossary && Object.keys(it.glossary).length) { %>- Use these renderings consistently:
<% Object.entries(it.glossary).forEach(function (entry) { %>  - `<%= entry[0] %>` → `<%= entry[1] %>`
<% }); } %><% if (it.partial) { %>- You are translating **part** of the document (<%= it.partLabel %>). Translate
  exactly this fragment; do not add an introduction or a conclusion, and do not
  close blocks that were opened before it.
<% } %>
Return the translated document only.
