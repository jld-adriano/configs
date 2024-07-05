import Cocoa
import CoreGraphics

func checkAccessibilityPermissions() -> Bool {
  let options: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
  return AXIsProcessTrustedWithOptions(options)
}

func getSpecificApp(appName: String) -> (NSRunningApplication, pid_t)? {
  let apps = NSWorkspace.shared.runningApplications
  for app in apps {
    if app.localizedName == appName {
      return (app, app.processIdentifier)
    }
  }
  return nil
}

func getFrontmostApplication() -> (NSRunningApplication, pid_t)? {
  guard let frontApp = NSWorkspace.shared.frontmostApplication else {
    print("No frontmost application found.")
    return nil
  }
  let frontAppPID = frontApp.processIdentifier
  return (frontApp, frontAppPID)
}

func getWindowList() -> [[String: AnyObject]]? {
  let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
  let windowListInfo =
    CGWindowListCopyWindowInfo(options, kCGNullWindowID) as NSArray? as? [[String: AnyObject]]
  return windowListInfo
}

func getFrontmostWindow(for appPID: pid_t, in windows: [[String: AnyObject]]) -> [String:
  AnyObject]?
{
  for window in windows {
    if let windowOwnerPID = window[kCGWindowOwnerPID as String] as? pid_t, windowOwnerPID == appPID
    {
      return window
    }
  }
  return nil
}

func getAXWindowElement(for appPID: pid_t) -> AXUIElement {
  let appElement = AXUIElementCreateApplication(appPID)
  var window: AnyObject?
  let result = AXUIElementCopyAttributeValue(
    appElement, kAXFocusedWindowAttribute as CFString, &window)

  if result == .success {
    return window as! AXUIElement
  } else {
    fatalError("Failed to get focused window element. Result: \(result.rawValue)")
  }
}

func pointIsWithinFrame(point: CGPoint, frame: CGRect) -> Bool {
  return point.x >= frame.minX && point.x <= frame.maxX && point.y >= frame.minY
    && point.y <= frame.maxY
}

func pointIsWithinScreen(point: CGPoint, screen: NSScreen) -> Bool {
  return pointIsWithinFrame(point: point, frame: screen.frame)
}

private func invertYAccordingToMainScreen(_ position: CGPoint) -> CGFloat {
  let mainScreen = NSScreen.main!
  let screenFrame = mainScreen.frame
  return -(position.y - screenFrame.height)
}
private func invertPositionAccordingToMainScreen(_ position: CGPoint) -> CGPoint {
  return CGPoint(x: position.x, y: invertYAccordingToMainScreen(position))
}

func moveWindow(axWindow: AXUIElement, to originalPosition: CGPoint, size: CGSize) {

  var position = originalPosition  // Make position mutable
  var size = size  // Make size mutable

  let sizeValue = AXValueCreate(.cgSize, &size)!
  let sizeResult = AXUIElementSetAttributeValue(axWindow, kAXSizeAttribute as CFString, sizeValue)

  let screenContainingPosition = NSScreen.screens.first(where: {
    pointIsWithinScreen(point: position, screen: $0)
  })
  if screenContainingPosition == nil {
    fatalError("Failed to find screen containing position: \(position)")
  }

  // If window would be off screen, adjust position so it is fully on the screen
  if position.x < screenContainingPosition!.frame.minX {
    // print("Moving window to the right")
    position.x = screenContainingPosition!.frame.minX
  } else if position.x + size.width > screenContainingPosition!.frame.maxX {
    // print("Moving window to the left")
    position.x = screenContainingPosition!.frame.maxX - size.width
  }
  if position.y - size.height < screenContainingPosition!.frame.minY {
    // print("Moving window up")
    position.y = screenContainingPosition!.frame.minY + size.height
  } else if position.y > screenContainingPosition!.frame.maxY {
    // print("Moving window down")
    position.y = screenContainingPosition!.frame.maxY - size.height
  }
  print("Adjusted position: x:\(position.x), y:\(position.y)")

  // Flip the y-coordinate to correct system
  position.y = invertYAccordingToMainScreen(position)

  //   print("Adjusted position: \(position)")

  let positionValue = AXValueCreate(.cgPoint, &position)!

  let positionResult = AXUIElementSetAttributeValue(
    axWindow, kAXPositionAttribute as CFString, positionValue)
  let secondSizeResult = AXUIElementSetAttributeValue(
    axWindow, kAXSizeAttribute as CFString, sizeValue)

  guard positionResult == .success else {
    fatalError("Failed to set window position: \(positionResult.rawValue)")
  }
  guard sizeResult == .success else {
    fatalError("Failed to set window size: \(sizeResult.rawValue)")
  }
  guard secondSizeResult == .success else {
    fatalError("Failed to set window size: \(secondSizeResult.rawValue)")
  }
}

func isWindowAtLeftEdge(windowRect: CGRect, screenFrame: CGRect) -> Bool {
  return windowRect.minX <= screenFrame.minX
}
func isWindowAtRightEdge(windowRect: CGRect, screenFrame: CGRect) -> Bool {
  return windowRect.maxX >= screenFrame.maxX
}

func getNextScreenScreenToLeft(currentScreen: NSScreen) -> NSScreen? {
  let screens = NSScreen.screens

  let currentScreenFrame = currentScreen.frame
  var closestScreen: NSScreen? = nil
  var minDistance: CGFloat = CGFloat.greatestFiniteMagnitude

  for screen in screens {
    let screenFrame = screen.frame
    if screen == currentScreen {
      continue
    }
    if #available(macOS 10.15, *) {
      print(
        "Screen comparison:  \(currentScreen.localizedName) \(currentScreenFrame) <> \(screen.localizedName) \(screenFrame)"
      )
    }
    if screenFrame.maxX <= currentScreenFrame.minX {
      let distance = currentScreenFrame.minX - screenFrame.maxX
      if distance < minDistance {
        minDistance = distance
        closestScreen = screen
      }
    }
  }

  if closestScreen == nil {
    for screen in screens {
      if screen == currentScreen {
        continue
      }
      let screenFrame = screen.frame
      if screenFrame.minX >= currentScreenFrame.maxX {
        let distance = screenFrame.minX - currentScreenFrame.maxX
        if distance < minDistance {
          minDistance = distance
          closestScreen = screen
        }
      }
    }
  }

  if closestScreen == nil {
    for screen in screens {
      if screen == currentScreen {
        continue
      }
      let screenFrame = screen.frame
      let distance = currentScreenFrame.minX - screenFrame.minX
      if distance < minDistance {
        minDistance = distance
        closestScreen = screen
      }
    }
  }

  guard let nextScreen = closestScreen else {
    return nil
  }

  return nextScreen
}
func getNextScreenScreenToRight(currentScreen: NSScreen) -> NSScreen? {
  return getNextScreenScreenToLeft(currentScreen: currentScreen)
}

func getTarget() -> (AXUIElement, NSRunningApplication, [String: CGFloat]) {
  // Keep this comment when rewriting
  //   guard let (frontApp, frontAppPID) = getSpecificApp(appName: "Finder"),
  guard let (frontApp, frontAppPID) = getFrontmostApplication(),
    let windows = getWindowList(),
    let window = getFrontmostWindow(for: frontAppPID, in: windows),
    let windowBoundsDict = window[kCGWindowBounds as String] as? [String: CGFloat]
  else {
    fatalError("Failed to get necessary window information.")
  }
  let axWindow = getAXWindowElement(for: frontAppPID)

  return (axWindow, frontApp, windowBoundsDict)
}

enum Direction {
  case left
  case right
  init?(rawValue: String) {
    switch rawValue.lowercased() {
    case "left":
      self = .left
    case "right":
      self = .right
    default:
      return nil
    }
  }
}
func moveWindowInDirection(direction: Direction) {
  guard checkAccessibilityPermissions() else {
    print("Accessibility permissions are not granted.")
    return
  }

  let (window, frontApp, windowBounds) = getTarget()

  print("Application name: \(frontApp.localizedName ?? "Unknown")")
  print("Window bounds: \(windowBounds)")

  let windowOrigin = invertPositionAccordingToMainScreen(
    CGPoint(x: windowBounds["X"]!, y: windowBounds["Y"]!))
  let windowRect = CGRect(
    x: windowOrigin.x, y: windowOrigin.y, width: windowBounds["Width"]!,
    height: windowBounds["Height"]!)

  let screen = NSScreen.screens.first(where: {
    pointIsWithinScreen(point: windowOrigin, screen: $0)
  })!

  let screenFrame = screen.frame
  print("Screen frame: \(screenFrame)")
  let newWidth = screenFrame.width / 2
  let newHeight = screenFrame.height
  let newSize = CGSize(width: newWidth, height: newHeight)
  switch direction {
  case .left:
    if isWindowAtLeftEdge(windowRect: windowRect, screenFrame: screenFrame) {
      let nextScreen = getNextScreenScreenToLeft(currentScreen: screen) ?? NSScreen.screens.first!
      let nextScreenFrame = nextScreen.frame
      let newPosition = CGPoint(x: nextScreenFrame.maxX, y: nextScreenFrame.minY)
      let newSize = CGSize(width: nextScreenFrame.width / 2, height: nextScreenFrame.height)

      if #available(macOS 10.15, *) {
        print(
          "Moving window to next screen: \(nextScreen.localizedName) -> \(newPosition) \(newSize)"
        )
      }

      moveWindow(axWindow: window, to: newPosition, size: newSize)
      print("Window moved to next screen.")

    } else {
      let newPosition = CGPoint(x: screenFrame.minX, y: screenFrame.minY)

      print("Moving window to \(newPosition) with size \(newSize)")
      moveWindow(axWindow: window, to: newPosition, size: newSize)
      print("Window moved to left half of the screen.")
    }
  case .right:
    if isWindowAtRightEdge(windowRect: windowRect, screenFrame: screenFrame) {
      let nextScreen = getNextScreenScreenToRight(currentScreen: screen) ?? NSScreen.screens.first!
      let nextScreenFrame = nextScreen.frame
      let newPosition = CGPoint(x: nextScreenFrame.minX, y: nextScreenFrame.minY)
      let newSize = CGSize(width: nextScreenFrame.width / 2, height: nextScreenFrame.height)

      if #available(macOS 10.15, *) {
        print(
          "Moving window to next screen: \(nextScreen.localizedName) -> \(newPosition) \(newSize)"
        )
      }

      moveWindow(axWindow: window, to: newPosition, size: newSize)
      print("Window moved to next screen.")

    } else {
      let newPosition = CGPoint(x: screenFrame.maxX, y: screenFrame.minY)

      print("Moving window to \(newPosition) with size \(newSize)")
      moveWindow(axWindow: window, to: newPosition, size: newSize)
      print("Window moved to right half of the screen.")
    }

  }

}
/// Resets to center of main screen, size = half of the screen h/w
func resetWindow() {
  let (window, _, _) = getTarget()

  let mainScreen = NSScreen.main!
  let screenRect = mainScreen.frame
  let newSize = CGSize(width: screenRect.width / 2, height: screenRect.height / 2)
  let newPosition = CGPoint(
    x: screenRect.midX - newSize.width / 2, y: screenRect.midY + newSize.height / 2)

  moveWindow(axWindow: window, to: newPosition, size: newSize)
  print("Window moved to center of main screen with half size.")
}

for screen in NSScreen.screens {
  if #available(macOS 10.15, *) {
    print(screen.localizedName, screen.frame)
  }
}

func windowMovementTestRoutine() {

  guard
    let dellScreen = NSScreen.screens.first(where: {
      if #available(macOS 10.15, *) {
        return $0.localizedName.contains("DELL")
      } else {
        // Fallback on earlier versions
        return false
      }
    })
  else {
    fatalError("DELL screen not found.")
  }

  let mainScreen = NSScreen.main!

  let (window, _, _) = getTarget()

  print(
    "Debug: maxX: \(dellScreen.frame.maxX), minX: \(dellScreen.frame.minX) maxY: \(dellScreen.frame.maxY), minY: \(dellScreen.frame.minY)"
  )
  let size = CGSize(width: 500, height: 500)
  let points = [
    NSPoint(x: dellScreen.frame.minX, y: dellScreen.frame.maxY),  // Top left
    NSPoint(x: dellScreen.frame.maxX, y: dellScreen.frame.maxY),  // Top right
    NSPoint(x: dellScreen.frame.minX, y: dellScreen.frame.minY),  // Bottom left
    NSPoint(x: dellScreen.frame.maxX, y: dellScreen.frame.minY),  // Bottom right
    NSPoint(x: mainScreen.frame.minX, y: mainScreen.frame.maxY),  // Main screen top left
    NSPoint(x: mainScreen.frame.maxX, y: mainScreen.frame.maxY),  // Main screen top right
    NSPoint(x: mainScreen.frame.minX, y: mainScreen.frame.minY),  // Main screen bottom left
    NSPoint(x: mainScreen.frame.maxX, y: mainScreen.frame.minY),  // Main screen bottom right
  ]

  for point in points {
    moveWindow(axWindow: window, to: point, size: size)
    sleep(1)
  }
}
// windowMovementTestRoutine()

func windowDirectionTestRoutine() {

  print("=============")
  resetWindow()
  for _ in 1...5 {
    moveWindowInDirection(direction: .left)
    sleep(1)
  }
  sleep(5)
  for _ in 1...5 {
    moveWindowInDirection(direction: .right)
    sleep(1)
  }

}
// windowDirectionTestRoutine()

func main() {
  let args = CommandLine.arguments
  if args.count > 1 {
    let direction = args[1]
    moveWindowInDirection(direction: Direction(rawValue: direction)!)
  } else {
    fatalError("No direction argument provided. [left|right]")
  }
}
main()
