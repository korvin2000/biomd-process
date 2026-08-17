Find the missing facts for the person described below.

- Language for all prose values: **<%= it.language %>**. Dates, the `country`
  code and `source` URLs are machine values and stay as specified.
<% if (it.requireSource) { %>- Every value needs a `source` URL; omit anything you cannot cite.
<% } %>
Return JSON only.
