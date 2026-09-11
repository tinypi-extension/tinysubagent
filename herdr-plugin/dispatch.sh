#!/usr/bin/env bash
# Pane entrypoint for the tinysubagent-panes herdr plugin.
#
# herdr starts this with HERDR_PLUGIN_ROOT set and only the environment the
# extension passed through --env, so PI_HERDR_LAUNCH_SCRIPT is the whole
# handshake: the extension writes the wrapper, then names it in that variable.
set -u

launch_script="${PI_HERDR_LAUNCH_SCRIPT:-}"

if [[ -z "$launch_script" ]]; then
	echo "tinysubagent-panes: PI_HERDR_LAUNCH_SCRIPT is unset or empty" >&2
	exit 64
fi

# A directory passes `-r`, so refuse it here rather than letting `bash <dir>` fail
# later with a message about the wrong thing.
if [[ -d "$launch_script" ]]; then
	echo "tinysubagent-panes: launch script is a directory: $launch_script" >&2
	exit 66
fi

if [[ ! -r "$launch_script" ]]; then
	echo "tinysubagent-panes: launch script is not readable: $launch_script" >&2
	exit 66
fi

exec bash "$launch_script"
