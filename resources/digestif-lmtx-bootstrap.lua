-- DigestiF bootstrap for LuaMetaTeX (LMTX) — last-resort fallback when no
-- luarocks/PATH digestif is available.
--
-- LuaMetaTeX's stock package.searchers[2] does not load modules from
-- package.path. This shim installs a normal searcher, then starts DigestiF.
--
-- Env: DIGESTIF_HOME required (e.g. ~/.digestif checkout). DIGESTIF_TEXMF and
-- DIGESTIF_DATA recommended (Node launcher sets DIGESTIF_DATA when home/data exists).
--
--   luametatex --luaonly digestif-lmtx-bootstrap.lua [--verbose]

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

package.searchers[2] = lua_path_searcher

require("digestif.langserver").main(arg)
