#!/usr/bin/osascript

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Move window right
# @raycast.mode compact

# Optional parameters:
# @raycast.icon ??
# @raycast.packageName window-management

use framework "Foundation"

tell application "System Events"
    -- set frontApp to first application process whose frontmost is true
    set frontApp to application process "Finder"
    tell frontApp
        set frontWindow to first window whose value of attribute "AXMain" is true
        
        -- Get the bounds of the current display
        set mainScreen to current application's NSScreen's mainScreen()
        set screenFrame to mainScreen's frame()
        
        -- Debug output for app, window, screen, and frame
        log "Front App: " & name of frontApp
        log "Front Window: " & name of frontWindow
       
        -- Extract width and height from screenFrame
        set screenWidth to item 1 of item 2 of screenFrame as number
        set screenHeight to item 2 of item 2 of screenFrame as number

        log "Screen Width: " & screenWidth
        log "Screen Height: " & screenHeight
        
        -- Calculate the new position and size
        set newLeft to 0
        set newTop to 0
        set newWidth to (screenWidth / 2) as integer
        set newHeight to screenHeight as integer

        -- Set the new position and size
        tell application "System Events" to tell process frontApp's name
            set position of frontWindow to {newLeft, newTop}
            set size of frontWindow to {newWidth, newHeight}
        end tell

        log "New position: {" & newLeft & ", " & newTop & "}"
        log "New size: {" & newWidth & ", " & newHeight & "}"
    end tell
end tell