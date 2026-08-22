Translate the <%= it.count %> text fragment(s) supplied below.

- Source language: **<%= it.sourceLanguageName %>**
- Target language: **<%= it.targetLanguageName %>**
- Anything not written in <%= it.sourceLanguageName %> —
  a name in Latin letters, the title of a work or an album, a quoted foreign
  phrase — is copied through exactly as it stands.
<% if (it.glossary && Object.keys(it.glossary).length) { %>- Use these renderings consistently:
<% Object.entries(it.glossary).forEach(function (entry) { %>  - `<%= entry[0] %>` → `<%= entry[1] %>`
<% }); } %>
Return one JSON object with the same keys and nothing else.
