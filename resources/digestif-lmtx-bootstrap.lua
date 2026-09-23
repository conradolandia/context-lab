-- DigestiF bootstrap for LuaMetaTeX (LMTX).
--
-- LuaMetaTeX's stock package.searchers[2] does not load modules from
-- package.path (package.searchpath finds files, but the searcher ignores them).
-- Without this shim, `require "digestif.langserver"` fails with
-- "no file 'digestif.langserver'" or DigestiF never starts correctly.
--
-- Usage (env DIGESTIF_HOME required; DIGESTIF_TEXMF recommended):
--   luametatex --luaonly digestif-lmtx-bootstrap.lua [--verbose]
--
-- DigestiF is an LSP server on stdio: silence until initialize is normal.

local home = os.getenv("DIGESTIF_HOME")
if not home or home == "" then
  io.stderr:write("digestif-lmtx-bootstrap: DIGESTIF_HOME is not set\n")
  os.exit(false)
end

package.path = home .. "/?.lua;" .. home .. "/?/init.lua;" .. (package.path or "")

local function lua_path_searcher(modname)
  local filename, err = package.searchpath(modname, package.path)
  if not filename then
    return err
  end
  local chunk, loaderr = loadfile(filename)
  if not chunk then
    return (
      "\n\terror loading module '"
      .. modname
      .. "' from file '"
      .. filename
      .. "':\n\t"
      .. tostring(loaderr)
    )
  end
  return chunk, filename
end

-- Keep preload searcher at [1]; replace the broken path searcher.
package.searchers[2] = lua_path_searcher

require("digestif.langserver").main(arg)
