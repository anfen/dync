// Shim for PushNotificationIOS which was removed from react-native core
// but is still lazily imported in react-native/index.js
export default {
  presentLocalNotification: () => {},
  scheduleLocalNotification: () => {},
  cancelAllLocalNotifications: () => {},
  removeAllDeliveredNotifications: () => {},
  getDeliveredNotifications: () => Promise.resolve([]),
  getScheduledLocalNotifications: () => Promise.resolve([]),
  addEventListener: () => ({ remove: () => {} }),
  removeEventListener: () => {},
  requestPermissions: () => Promise.resolve({ alert: false, badge: false, sound: false }),
  abandonPermissions: () => {},
  checkPermissions: () => Promise.resolve({ alert: false, badge: false, sound: false }),
  getInitialNotification: () => Promise.resolve(null),
  getApplicationIconBadgeNumber: () => Promise.resolve(0),
  setApplicationIconBadgeNumber: () => {},
};
