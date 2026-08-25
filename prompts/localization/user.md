Localize the field values supplied below.

- Source language: **<%= it.sourceLanguageName %>**
- Target language: **<%= it.targetLanguageName %>**
- A value already written in <%= it.targetLanguageName %> comes back unchanged.
  Render names and titles according to the hard rules; do not translate a name's
  meaning.
<% if (it.glossary && Object.keys(it.glossary).length) { %>- Use these renderings consistently:
<% Object.entries(it.glossary).forEach(function (entry) { %>  - `<%= entry[0] %>` → `<%= entry[1] %>`
<% }); } %>
Return one JSON object with the same keys and nothing else — all <%= it.count %> of them.
