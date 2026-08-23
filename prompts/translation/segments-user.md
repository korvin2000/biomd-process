Translate the text fragments supplied below.

- Source language: **<%= it.sourceLanguageName %>**
- Target language: **<%= it.targetLanguageName %>**
- Text not written in <%= it.sourceLanguageName %> is copied through exactly as
  it stands; a title written in the source language is translated like any other
  text.
<% if (it.glossary && Object.keys(it.glossary).length) { %>- Use these renderings consistently:
<% Object.entries(it.glossary).forEach(function (entry) { %>  - `<%= entry[0] %>` → `<%= entry[1] %>`
<% }); } %>
Return one JSON object with the same keys and nothing else — all <%= it.count %> of them.
