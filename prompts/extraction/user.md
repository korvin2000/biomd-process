Extract the facts from the article below.

- Language for all prose values: **<%= it.language %>**
- Work through **every** key in the list and search the **whole** text for each
  one. A key is left out only after you have looked and the text is silent.
<% if (it.requiredFields && it.requiredFields.length) { %>- These must never be left out when the text supports them at all: <%= it.requiredFields.join(', ') %>. They are the minimum, not the target.
<% } %><% if (it.partial) { %>- You are seeing **part** of the article (<%= it.partLabel %>). Answer what this
  part supports and omit the rest; the parts are merged afterwards.
<% } %>
Return the JSON object and nothing else.
