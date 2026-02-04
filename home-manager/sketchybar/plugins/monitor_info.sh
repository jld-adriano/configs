#!/bin/bash

# Full paths for nix binaries
BAR="/run/current-system/sw/bin/sketchybar"
AEROSPACE="/run/current-system/sw/bin/aerospace"

# MONITOR_NUM is passed from the main config
# Fall back to 1 if not set
MONITOR_NUM=${MONITOR_NUM:-1}

# Count monitors
MONITOR_COUNT=$($AEROSPACE list-monitors 2>/dev/null | wc -l | tr -d ' ')
[ -z "$MONITOR_COUNT" ] || [ "$MONITOR_COUNT" -eq 0 ] && MONITOR_COUNT=1

# Get the focused workspace
FOCUSED_WS=$($AEROSPACE list-workspaces --focused 2>/dev/null)
[ -z "$FOCUSED_WS" ] && FOCUSED_WS="?"

# Calculate VD number: VD = ceil(workspace / monitor_count)
if [ "$MONITOR_COUNT" -gt 0 ] && [ "$FOCUSED_WS" != "?" ]; then
  VD=$(( (FOCUSED_WS - 1) / MONITOR_COUNT + 1 ))
else
  VD="?"
fi

# Calculate this monitor's workspace in current VD
if [ "$VD" != "?" ] && [ "$MONITOR_COUNT" -gt 0 ]; then
  MONITOR_WS=$(( (VD - 1) * MONITOR_COUNT + MONITOR_NUM ))
else
  MONITOR_WS="?"
fi

# Format output
$BAR --set $NAME label="M$MONITOR_NUM │ VD$VD │ WS$MONITOR_WS"
