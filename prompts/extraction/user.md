Extract the facts from the article below.

- Language for all prose values: **<%= it.language %>**
<% if (it.requiredFields && it.requiredFields.length) { %>- Answer these keys if the text supports them at all: <%= it.requiredFields.join(', ') %>
<% } %><% if (it.partial) { %>- You are seeing **part** of the article (<%= it.partLabel %>). Answer what this
  part supports and omit the rest; the parts are merged afterwards.
<% } %>
Return the JSON object and nothing else.
