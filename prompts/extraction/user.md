Extract the metadata for the article supplied below.

- Language for all prose values: **<%= it.language %>**
<%_ if (it.requiredFields && it.requiredFields.length) { _%>
- These fields must be present if the text supports them at all:
<%_ it.requiredFields.forEach(function (field) { _%>
  - `<%= field %>`
<%_ }); _%>
<%_ } _%>
<%_ if (it.partial) { _%>
- You are seeing **part** of the article (<%= it.partLabel %>). Extract what this
  part supports and omit the rest; the parts are merged afterwards.
<%_ } _%>

Return the JSON object and nothing else.
