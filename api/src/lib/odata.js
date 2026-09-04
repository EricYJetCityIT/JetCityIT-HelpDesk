// OData string literals escape an embedded single quote by doubling it.
// Shared by every function/lib file that builds a Table Storage filter
// string -- most values interpolated here are server-generated or
// whitelist-checked already, but this is cheap defense-in-depth against
// filter injection regardless.
function odataEscape(s) {
  return String(s).replace(/'/g, "''");
}

module.exports = { odataEscape };
