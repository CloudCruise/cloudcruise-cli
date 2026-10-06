declare module "update-notifier" {
  interface Package {
    name: string
    version: string
  }

  interface Options {
    pkg: Package
    updateCheckInterval?: number
  }

  interface NotifyOptions {
    message?: string
    defer?: boolean
    isGlobal?: boolean
  }

  interface UpdateInfo {
    current: string
    latest: string
    type: string
    name: string
  }

  interface Notifier {
    update?: UpdateInfo
    notify(options?: NotifyOptions): void
  }

  export default function updateNotifier(options: Options): Notifier
}
