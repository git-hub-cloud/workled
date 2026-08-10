# Macro Format Reference

This document details the macro key sequence format used by the workled device.

## Syntax

Format: Key1+Key2;Key3
- + = simultaneous keys
- ; = sequential keystrokes

## Segment Overview

- Key combo like: `a` / `ctrl+shift+a` ...
- `press` / `release`: hold and release a key combo
- `delay` / `delay_rand`: wait fixed or random ms
- `text "..."`: type ASCII text (double quotes required)
- `password "..."`: type a password stored in encrypted NVS (double quotes required)
- `mouse_move x y`: relative cursor move
- `mouse_scroll w [pan]`: wheel scroll
- `mouse_button left|right|middle click|down|up`: click or hold a mouse button
- Media keys like `volume_up` / `play_pause` ...

### Key Combo
Press and release a key combination
- `a` - press key and release
- `shift+ctrl+a` - press key and release

### press
Press and hold
- `press space` - press key and not release

### release
Release a key
- `release shift+a; release ctrl+b` - release key

### delay
Wait N ms
- `delay 50` - delay ms

### delay_rand
Random wait between MIN-MAX ms
- `delay_rand 100 500` - delay rand ms

### text
Type ASCII text. Text MUST be wrapped in double quotes. Escape sequences `\"` and `\\` only; `;` inside double quotes is literal.

- `text "hello"` - quoted text
- `text "Abc123"` - mixed case digits
- `text "hello world"` - quoted with spaces
- `text "hello;world"` - semicolon literal inside quotes
- `text "hello\\world"` - escaped backslash
- `text "hello\"world"` - escaped quote
- `text "a\\\"b"` - double escape (backslash then quote)
- `text "hello,world!"` - punctuation supported

### password
Type password text. Password MUST be wrapped in double quotes. Escape sequences `\"` and `\\` only; `;` inside double quotes is literal.
Password is lcoal hardware encrypted, and the stored/queried macro shows `*`. A macro may contain multiple `password` segments;

- `password "Abc123"` - quoted password
- `password "p@ss w0rd"` - spaces and symbols supported
- `password "a\\\"b"` - escaped quote inside password

### mouse_move
Move the mouse cursor by a relative delta. Both x and y are required and must be in -128..127.
- `mouse_move 30 0` - move right 30 px
- `mouse_move 0 -40` - move up 40 px

### mouse_scroll
Scroll the mouse wheel. Wheel is required; optional pan (horizontal) defaults to 0. Both in -128..127.
- `mouse_scroll -3` - scroll down 3 notches
- `mouse_scroll 0 3` - pan right

### mouse_button
Click or hold a mouse button. Button: left, right, middle. Gesture: click (default), down, up.
- `mouse_button left click` - left click
- `mouse_button right click` - right click
- `mouse_button left down` - press and hold left button
- `mouse_button left up` - release left button

### Media keys
Click media keys.
- `volume_up` - volume up one step
- `volume_down` - volume down one step
- `mute` - toggle mute
- `play_pause` - play or pause media
- `next_track` - next track
- `previous_track` - previous track

## Key Names (case-insensitive)

Letters: a-z
Digits: 0-9
Function: f1-f12
Navigation: enter, esc, tab, space, backspace, delete, insert, home, end, page_up, page_down
Arrows: up, down, left, right
Lock: caps_lock, num_lock, scroll_lock
System: print_screen, pause, menu
Media: mute, volume_up, volume_down, play_pause, next_track, previous_track

## Modifiers

Control: ctrl, left_ctrl, right_ctrl
Shift: shift, left_shift, right_shift
Alt: alt, left_alt, right_alt
GUI: gui, left_gui, right_gui, command, cmd, meta, win

## Examples

- `text "Hello"; delay 500; text "World"` - type with delay
- `text "Hello"; delay_rand 100 200; text "World"` - type with random delay
- `press shift; text "abc"; release shift` - type uppercase ABC (external SHIFT)
- `press shift; text "ABC"; release shift` - type uppercase ABC (SHIFT mask merge, no double shift)
- `press shift; text "aBc"; release shift` - type uppercase ABC (case ignored while shift held)
- `press ctrl; text "cv"; release ctrl` - copy and paste
- `ctrl+c; ctrl+v` - copy and paste
- `text "Line 1"; enter; text "Line 2"` - multi-line input
- `text "Tab"; tab; text "After tab"` - using tab key
- `text "Arrow"; up; down; left; right` - arrow keys
- `press ctrl; press a; release a; release ctrl` - type ctrl+A (press/release)
- `volume_up; delay 100; volume_down` - Volume sequence
- `mouse_button left down; mouse_move 40 10; mouse_move -30 -50; mouse_button left up` - drag left button
- `mouse_button right click; down; enter` - context menu then confirm
- `press gui; r; release gui; delay 100; text "notepad"; enter` - Windows open Application notepad
- `gui+l; delay 1000; enter; password "hello"; enter` - Windows unlock: lock screen, wait for display wake time, then type
- `ctrl+cmd+q; delay 1000; enter; password "hello"; enter` - Mac unlock: lock screen, wait for display wake time, then type
