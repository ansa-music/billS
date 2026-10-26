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

`--serial` — образ для проверки в QEMU (`TS-minipc-<версия>-serial.iso`): те же пункты меню, только меню дублируется на COM-порт, ядру добавлено `console=ttyS0,115200n8 console=tty0` (установщик остаётся на экране), а журнал установщика уходит на хост QEMU (`log_host=10.0.2.2 log_port=5514 DEBCONF_DEBUG=5`). Установленная система с `console=ttyS…` дублирует журнал systemd на этот порт (late.sh).

CI: `.github/workflows/minipc.yml` — job `iso` собирает обычный и `--serial` образы; `install-test` (BIOS, UEFI, UEFI Secure Boot) ставит `--serial` образ в QEMU; `release` (только тег `minipc-v<версия>`) выпускает «TS для мини-ПК <версия>», если проверка прошла. PR/ручной запуск → образы в артефактах на 3 дня; в ручном запуске проверку можно выключить (`install_test`).

## Проверка в QEMU

Автоматически (так же в CI, job `install-test`):

```bash
sudo apt-get install -y qemu-system-x86 qemu-utils ovmf
deploy/minipc/build-iso.sh --serial --out /tmp/out
deploy/minipc/test/vm-test.sh --iso /tmp/out/TS-minipc-<версия>-serial.iso --firmware uefi --out /tmp/vm   # bios | uefi | uefi-sb
```

Флешка — USB (`usb-storage`, pick-disk.sh её исключает), диск — пустой NVMe 20 ГБ, сеть — DHCP QEMU с пробросом `127.0.0.1:14310 → 4310`. Этапы: установка без вопросов (QEMU с `-no-reboot` завершается на перезагрузке) → первая загрузка до `GET /api/setup/status` = `"open":true`, `/api/health` ok, `/setup` 200 → выключение кнопкой питания (ACPI) и повторная загрузка. В UEFI флешка остаётся вставленной (проверка «забытой флешки»), в BIOS — вынимается. Тайм-ауты: 50 + 50 + 15 мин с KVM, без KVM ×3. Результаты в `--out`: `serial-*.log`, `installer-syslog.log` (с вопросами debconf; установка, молчащая 15 мин, считается зависшей), `screens/*.png` (раз в минуту), `api-*.json`, `guest-logs/` (с диска гостя через qemu-nbd, нужен sudo: журнал установщика, `ts-firstboot.log`, journal), `result.txt`.

Вручную:

```bash
qemu-img create -f qcow2 disk.qcow2 20G
cp /usr/share/OVMF/OVMF_VARS_4M.fd vars.fd
qemu-system-x86_64 -machine q35 -m 4096 -enable-kvm \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd -drive if=pflash,format=raw,file=vars.fd \
  -drive file=TS-minipc-0.1.0.iso,format=raw,if=none,id=usb,readonly=on -device qemu-xhci -device usb-storage,drive=usb,removable=on,bootindex=0 \
  -drive file=disk.qcow2,if=none,id=hd -device nvme,serial=TS1,drive=hd,bootindex=1 \
  -nic user,model=virtio-net-pci,hostfwd=tcp::14310-:4310
```

Без `pflash`-строк — загрузка BIOS.
