# Mounting the plugin locally

## Install into a profile

The package is `private`, so it is not published to npm. Install it by path:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh_dream_rsi
```

This appends the package to the profile's `package.json` `dependencies` and to
`dsh.profile.bundles`. Because `package.json` declares `dsh.bundle.patch`, the
loader reads the package's own `cordis.patch.yml` and mounts the row it inserts.

A package that is in `dsh.profile.bundles` without a readable
`dsh.bundle.patch` target never mounts.

## Override the configuration

`cordis.patch.yml` in this directory is a user patch layer for a profile. Copy
it next to the profile's own patch file, or merge the entry into it. It
addresses the mount row by id.

## What mounting registers

Four tools: `embodied_perceive`, `embodied_act`, `embodied_query_state`, and
`dream_status`. Evolution and auto-deployment stay off unless the config enables
them.

## Loader schema

A patch file is a top-level YAML array of entries. An entry either inserts rows
or addresses an existing id:

```yaml
- insert:
    - id: <stable id>
      name: <module specifier>
      config: {}          # validated against the plugin's exported `Config`
      group: false
      disabled: false
      inject: null
```

`!!js` expressions are allowed where the loader evaluates them.
