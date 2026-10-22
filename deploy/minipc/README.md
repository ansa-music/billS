# Образ «TS для мини-ПК»

Флешка, которая сама ставит систему и TS HUB на мини-ПК клуба. Инструкция для владельца — [docs/MINIPC_RU.md](../../docs/MINIPC_RU.md).

## Решение: Debian 13 netinst + preseed

| Вариант | Итог |
|---|---|
| **(a) Ремикс Debian netinst (~0,8 ГБ) с preseed** | **выбран.** Полностью автоматическая установка, помещается в предел GitHub Releases (2 ГиБ на файл), собирается на бесплатном раннере за несколько минут. Пакеты и TS скачиваются из интернета во время установки — нужен кабель |
| (b) Ubuntu 24.04 autoinstall | live-server ISO ~2,7 ГБ: ремикс не опубликовать в Releases. «Seed»-том рядом со стоковым ISO = две флешки/Ventoy — для владельца клуба слишком сложно |
| (c) «Поставьте Ubuntu → одна команда» | оставлен как запасной путь (`install.sh`, раздел в docs/MINIPC_RU.md) |

`install.sh` уже поддерживает Debian (NodeSource `nodistro` работает и на Debian, есть запасной архив nodejs.org); для минимального Debian добавлены `sudo` и `/usr/sbin` в PATH, плюс флаг `--mdns-name`.

## Как устроено

```
флешка (ISO)                                  установленная система
 ├ меню GRUB (UEFI) / isolinux (BIOS)          ├ /opt/ts-minipc/{firstboot.sh,console.sh,build-info,linux/}
 │   «Установить TS (СОТРЁТ ВСЕ ДАННЫЕ…)»,     ├ /etc/ts-minipc/image-info   ← признак «TS стоит»
 │   таймаут 15 с; если TS уже стоит —         ├ ts-firstboot.service  → install.sh --ref <коммит сборки> --mdns-name hub
 │   по умолчанию загрузка с диска (5 с)       ├ ts-console.service    → tty1: ход установки / адрес /setup + QR
 ├ /install.amd/initrd.gz      (Debian, как есть, для ручной установки)
 └ /install.amd/ts-initrd.gz = initrd.gz + cpio: /preseed.cfg, /ts-minipc/{pick-disk.sh,late.sh,templates,network/,target/}
```

- **preseed.cfg** — ответы установщику: ru_RU.UTF-8, Asia/Almaty, хост `ts-hub`, DHCP (без сети — повтор), разметка всего диска без LVM (ESP при UEFI + ext4 `TS-HUB` + swap), минимум пакетов + `qrencode`, `console-setup`, `unattended-upgrades`, GRUB с копией в `EFI/BOOT/BOOTX64.EFI`.
- **d-i/pick-disk.sh** (`partman/early_command`) — диск: самый большой внутренний от 14 ГиБ; флешка установки, USB, съёмные и read-only исключены. Если на внутренних дисках найден TS (метка `TS-HUB`, `/etc/ts-minipc/image-info`, `/etc/bills/hub.env`, `/var/lib/bills/hub.db`) — сообщение и остановка, ничего не стирается. Пункт «Переустановить TS заново» передаёт `ts_reinstall=1`.
- **d-i/late.sh** (`preseed/late_command`) — копирует `target/`, включает службы, убирает getty с tty1, шрифт `FullCyrSlav` (кириллица и ▀▄ для QR), сеть на systemd-networkd + resolved (DHCP на любом проводном порту, без перезагрузки при позднем кабеле/роутере; mDNS у resolved выключен — `hub.local` объявляет сам HUB).
- **Доступ:** root закрыт, пользователь `ts` (sudo) с паролем, который задаёт первая загрузка; пароль виден на экране только до завершения мастера (`/api/setup/status` → `open:false`, либо в hub.env уже есть подключение к облаку), копия — `/var/lib/ts-minipc/admin-password` (root). SSH не ставится; поддержка — `sudo bills tailscale` с консоли.
- **Экран (console.sh):** опрос каждые 3 с; `/api/setup/status` 404 = «неизвестно» → показывается адрес настройки, пока HUB не подключён к облаку.

## Сборка

```bash
sudo apt-get install -y xorriso cpio gzip curl openssl gnupg grub-common
deploy/minipc/build-iso.sh --version 0.1.0              # ref = текущий коммит (должен быть на GitHub)
deploy/minipc/build-iso.sh --ref main --debian 13.1.0 --out /tmp/out
deploy/minipc/build-iso.sh --iso ~/debian-13.1.0-amd64-netinst.iso   # без скачивания
```

Результат: `dist/minipc/TS-minipc-<версия>.iso` и `.sha256`. Скрипт проверяет SHA512SUMS и подпись Debian CD (`--gpg auto|require|off`), не требует root, падает, если образ больше 2 ГиБ.

CI: `.github/workflows/minipc.yml` — PR/ручной запуск → артефакт на 3 дня; тег `minipc-v<версия>` → выпуск «TS для мини-ПК <версия>».

## Проверка в QEMU

```bash
qemu-img create -f qcow2 disk.qcow2 20G
cp /usr/share/OVMF/OVMF_VARS_4M.fd vars.fd
qemu-system-x86_64 -m 4096 -enable-kvm \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd -drive if=pflash,format=raw,file=vars.fd \
  -drive file=TS-minipc-0.1.0.iso,format=raw,if=none,id=usb,readonly=on -device qemu-xhci -device usb-storage,drive=usb,bootindex=0 \
  -drive file=disk.qcow2,if=none,id=hd -device virtio-blk-pci,drive=hd,bootindex=1 \
  -nic user,model=virtio-net-pci
```

Без `pflash`-строк — загрузка BIOS. Флешка подключена как USB — так pick-disk.sh её исключает, как на настоящем мини-ПК.
