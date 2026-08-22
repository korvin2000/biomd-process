Find the missing facts for the <% if (it.collective) { %>ensemble<% } else { %>person<% } %> described below.

- Language for all prose values: **<%= it.languageName %>**. Dates,
  the `country` code and `source` URLs are machine values and stay as specified.
<% if (it.requireSource) { %>- Every value needs a `source` URL; omit anything you cannot cite.
<% } %><% if (it.collective) { %>- This entry is a collective — a duo, a trio, a quartet, an ensemble. Its
  members are not the subject: an answer about one of them is an answer about
  somebody else, and belongs nowhere in this reply.
<% } %>
Return JSON only.
