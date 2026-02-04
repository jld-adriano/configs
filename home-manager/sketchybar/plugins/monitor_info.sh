#!/bin/bash

# Get current display info from sketchybar
DISPLAY_ID=$DISPLAY

# Count monitors and figure out which one this bar is on
MONITOR_COUNT=$(aerospace list-monitors 2>/dev/null | wc -l | tr -d ' ')

if [ -z "$MONITOR_COUNT" ] || [ "$MONITOR_COUNT" -eq 0 ]; then
  MONITOR_COUNT=1
fi

# Get the focused workspace
FOCUSED_WS=$(aerospace list-workspaces --focused 2>/dev/null)

if [ -z "$FOCUSED_WS" ]; then
  FOCUSED_WS="?"
fi

# Calculate VD number: VD = ceil(workspace / monitor_count)
if [ "$MONITOR_COUNT" -gt 0 ] && [ "$FOCUSED_WS" != "?" ]; then
  VD=$(( (FOCUSED_WS - 1) / MONITOR_COUNT + 1 ))
else
  VD="?"
fi

# Determine which monitor this sketchybar instance is on
# DISPLAY variable from sketchybar gives us the display index (1-based)
MONITOR_NUM=${DISPLAY:-1}

# Calculate this monitor's workspace in current VD
if [ "$VD" != "?" ] && [ "$MONITOR_COUNT" -gt 0 ]; then
  MONITOR_WS=$(( (VD - 1) * MONITOR_COUNT + MONITOR_NUM ))
else
  MONITOR_WS="?"
fi

# Format output
sketchybar --set $NAME label="MON $MONITOR_NUM  │  VD $VD  │  WS $MONITOR_WS"
