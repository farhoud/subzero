---
name: init
description: Write the starter agent entries for a model into this project's .agents/subzero.yaml, so subzero can delegate work to it. Run it yourself with /subzero:init <model>.
argument-hint: "<model> [--host pi] [--timeout seconds] [--thinking level]"
disable-model-invocation: true
allowed-tools:
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" init *)'
---

# Set up subzero for a model

Run exactly this command, with the user's arguments in place of `$ARGUMENTS`:

```sh
SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" init $ARGUMENTS
```

The arguments are `<model>` (for pi, a `provider/model` name such as
`local/qwen`) and, optionally, `--host <host>` (default `pi`),
`--timeout <seconds>` and `--thinking <level>`. If the user gave no model, ask
which model to use and do not run the command until you have one.

Show the command's output to the user unchanged, whether it succeeded or
failed. Do not create, edit or delete any file yourself, including
`.agents/subzero.yaml`, and do not install anything: the command writes the
file. If it reports that something is missing, such as Node 22 or pi, relay
that message and stop.
