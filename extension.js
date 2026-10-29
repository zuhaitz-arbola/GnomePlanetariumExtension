/**
 * extension.js — Gnome Planetarium Extension GNOME Shell Extension
 *
 * Renders a real-time solar system orrery in the top panel using
 * St.DrawingArea + Cairo, and displays a detailed top-down view
 * of all 8 planets with Keplerian orbital data in a popup menu.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib   from 'gi://GLib';
import Gio    from 'gi://Gio';
import GObject from 'gi://GObject';
import St     from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta    from 'gi://Meta';
import Pango   from 'gi://Pango';

import * as Main      from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/* Local orbital calculation module. */
import * as Orbital from './orbital.js';

/* ------------------------------------------------------------------ */
/*  Constants & Dimensions                                              */
/* ------------------------------------------------------------------ */

const TWO_PI = 2 * Math.PI;
const DEG    = Math.PI / 180;

/* Panel icon dimensions (matching Gnome Sun Extension/Moon 1:1). */
const ICON_W = 22;
const ICON_H = 22;

/* Orrery popup diagram height (matching Gnome Sun Extension/Moon). Width adapts to popup. */
const ORRERY_H = 240;

/* Planet hit-test radius for hover detection (pixels). */
const HIT_RADIUS = 14;

/* ------------------------------------------------------------------ */
/*  Colour Palette                                                      */
/* ------------------------------------------------------------------ */

const C = {
    /* Diagram background (Pure Black) */
    diagBg:    [0.00, 0.00, 0.00, 1.0],

    /* Orbit rings */
    orbitRing: [1.00, 1.00, 1.00, 0.25],

    /* Sun core */
    sunCore:   [1.00, 1.00, 1.00, 1.0],
    sunGlow1:  [1.00, 1.00, 1.00, 0.25],
    sunGlow2:  [1.00, 1.00, 1.00, 0.10],

    /* Earth crosshair */
    earthCross:[0.30, 0.65, 0.95, 0.50],

    /* Explanatory text */
    explText:  [0.56, 0.58, 0.65, 0.50],

    /* Panel icon */
    panelBright: [1.00, 1.00, 1.00, 1.0],
    panelDim:    [1.00, 1.00, 1.00, 0.35],
    panelOrbit:  [1.00, 1.00, 1.00, 0.25],
};

/* Planet name translation keys (must match orbital.js names). */
const PLANET_KEYS = [
    'Mercury', 'Venus', 'Earth', 'Mars',
    'Jupiter', 'Saturn', 'Uranus', 'Neptune',
];

/* Season translation keys. */
const SEASON_KEYS = ['Spring', 'Summer', 'Autumn', 'Winter'];

/* Equinox/Solstice event translation keys. */
const EVENT_KEYS = [
    'Spring Equinox', 'Summer Solstice',
    'Autumn Equinox', 'Winter Solstice',
];

/* ------------------------------------------------------------------ */
/*  OrreryIndicator — PanelMenu.Button subclass                         */
/* ------------------------------------------------------------------ */

const OrreryIndicator = GObject.registerClass(
class OrreryIndicator extends PanelMenu.Button {

    _init(ext) {
        super._init(0.5, 'Gnome Planetarium Extension');
        this.add_style_class_name("gnomeplanetariumextension-panel-button");

        this._ext       = ext;
        this._settings  = ext.getSettings();
        this._positions = null;   /* Array of planet position objects */
        this._timerId   = 0;
        this._hoveredPlanet = null;  /* Name of hovered planet or null */
        this._planetScreenPositions = [];  /* [{name, sx, sy}] for hit testing */
        this._zoom = 1.0; /* Interactive zoom factor (0.4x to 5.0x) */
        this._simTimerId = 0;
        this._simStep = 0;

        /* ----- Panel Icon ----- */
        this._panelIcon = new St.DrawingArea({
            style_class: 'gnomeplanetariumextension-panel-icon',
            width:  ICON_W,
            height: ICON_H,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelIcon.connect('repaint', (area) => this._drawPanelIcon(area));
        this.add_child(this._panelIcon);

        /* ----- Popup Menu Construction ----- */
        this._buildPopupMenu();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                this._stopTicker();
                this._resetSimulation();
            } else {
                this._update();
            }
        });

        /* ----- Settings Signals ----- */
        this._settingsIds = [
            this._settings.connect('changed::latitude',         () => this._update()),
            this._settings.connect('changed::longitude',        () => this._update()),
            this._settings.connect('changed::refresh-interval', () => this._restartTimer()),
        ];

        /* ----- Theme Detection (GNOME Official Light/Dark Mode) ----- */
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._themeSettingsId = this._interfaceSettings.connect(
            'changed::color-scheme',
            () => this._updateTheme()
        );
        this._updateTheme();

        /* ----- Initial Update & Timer ----- */
        this._update();
        this._startTimer();
    }

    /* ============================================================== */
    /*  Popup Menu Construction                                        */
    /* ============================================================== */

    _buildPopupMenu() {
        
        /* 1. Cairo Orrery Diagram */
        this._orreryArea = new St.DrawingArea({
            style_class: 'gnomeplanetariumextension-orrery-diagram',
            height: ORRERY_H,
            x_expand: true,
            reactive: true,
        });
        this._orreryArea.connect('repaint', (area) => this._drawOrrery(area));

        /* Mouse wheel zoom in / zoom out */
        this._orreryArea.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP) {
                this._zoom = Math.min(5.0, this._zoom * 1.2);
            } else if (direction === Clutter.ScrollDirection.DOWN) {
                this._zoom = Math.max(0.4, this._zoom / 1.2);
            }
            this._orreryArea.queue_repaint();
            return Clutter.EVENT_STOP;
        });


        /* Hover detection on the drawing area */
        this._orreryArea.connect('motion-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const [ok, ax, ay] = this._orreryArea.transform_stage_point(x, y);
            if (!ok) return Clutter.EVENT_PROPAGATE;
            this._checkHover(ax, ay);
            return Clutter.EVENT_PROPAGATE;
        });
        this._orreryArea.connect('leave-event', () => {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
            if (this._hoveredPlanet !== null) {
                this._hoveredPlanet = null;
                this._orreryArea.queue_repaint();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const diagItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        diagItem.add_child(this._orreryArea);
        this.menu.addMenuItem(diagItem);

        /* Separator */
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        /* 3. Info Rows Container */
        this._infoBox = new St.BoxLayout({
            vertical: true,
            style_class: 'gnomeplanetariumextension-info-box',
            x_expand: true,
        });
        const infoItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        infoItem.add_child(this._infoBox);
        this.menu.addMenuItem(infoItem);

        /* 2. Top Status Card (single continuous line of text in white) */
        this._statusContainer = new St.BoxLayout({
            style_class: 'gnomeplanetariumextension-visible-badge',
            width: 232,
            clip_to_allocation: true,
        });

        this._statusHeader = new St.Label({
            style_class: 'gnomeplanetariumextension-badge-header',
            x_expand: true,
        });
        this._statusHeader.clutter_text.line_wrap = false;

        this._statusContainer.add_child(this._statusHeader);
        this._infoBox.add_child(this._statusContainer);

        /* Create Info Rows */
        this._rows = {};
        const fields = [
            ['closestPlanet',    _('Closest Planet')],
            ['earthSunDist',     _('Sun Distance')],
            ['orbitalVelocity',  _('Velocity')],
            ['dayOfYear',        _('Day of Year')],
            ['season',           _('Season')],
            ['nextEvent',        _('Next Event')],
        ];
        for (const [key, label] of fields) {
            const row = new St.BoxLayout({style_class: 'gnomeplanetariumextension-info-row', x_expand: true});
            const lbl = new St.Label({style_class: 'gnomeplanetariumextension-info-label', text: label, x_expand: true, x_align: Clutter.ActorAlign.START});
            
            let valWidget;
            const val = new St.Label({style_class: 'gnomeplanetariumextension-info-value', text: '—', x_expand: true, x_align: Clutter.ActorAlign.END});
            
            if (key === 'nextEvent' || key === 'closestPlanet') {
                const valWrapper = new St.BoxLayout({
                    style_class: 'gnomeplanetariumextension-value-wrapper',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.END,
                    clip_to_allocation: true,
                });
                valWrapper.add_child(val);
                valWidget = valWrapper;
            } else {
                valWidget = val;
            }

            row.add_child(lbl);
            row.add_child(valWidget);
            this._infoBox.add_child(row);
            this._rows[key] = val;
        }

        /* Separator before footer block */
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        /* Single Footer Row: Left = Play Button [ ▶ ], Center = Spacer, Right = Icon Buttons (Help + Settings) */
        const footerRow = new St.BoxLayout({
            style_class: 'gnomeastro-footer-row',
            x_expand: true,
        });

        this._playIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 16,
        });

        this._playBtn = new St.Button({
            style_class: 'gnomeplanetariumextension-play-button',
            child: this._playIcon,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._playBtn.connect('clicked', () => this._toggleSimulation());

        let simTooltip = _('Annual orbit simulation');
        this._addTooltip(this._playBtn, simTooltip);

        const footerSpacer = new St.Widget({
            x_expand: true,
        });

        const helpBtn = new St.Button({
            style_class: 'gnomeastro-footer-btn',
            child: new St.Icon({
                icon_name: 'help-about-symbolic',
                icon_size: 16,
            }),
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        helpBtn.connect('clicked', () => {
            try {
                GLib.file_set_contents('/tmp/gnome_astro_tab.txt', 'help');
            } catch (e) {}
            this._ext.openPreferences();
        });

        const settingsBtn = new St.Button({
            style_class: 'gnomeastro-footer-btn',
            child: new St.Icon({
                icon_name: 'emblem-system-symbolic',
                icon_size: 16,
            }),
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        settingsBtn.connect('clicked', () => {
            try {
                GLib.file_set_contents('/tmp/gnome_astro_tab.txt', 'config');
            } catch (e) {}
            this._ext.openPreferences();
        });

        footerRow.add_child(this._playBtn);
        footerRow.add_child(footerSpacer);
        footerRow.add_child(helpBtn);
        footerRow.add_child(settingsBtn);

        const footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        footerItem.add_child(footerRow);
        this.menu.addMenuItem(footerItem);

        /* Fade-in popover & Heartbeat timer */
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this.menu.box.opacity = 0;
                this.menu.box.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                
                this._heartbeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (this._orreryArea) this._orreryArea.queue_repaint();
                    return GLib.SOURCE_CONTINUE;
                });
            } else {
                if (this._heartbeatId) {
                    GLib.source_remove(this._heartbeatId);
                    this._heartbeatId = null;
                }
            }
        });
    }

    /* ============================================================== */
    /*  Theme Detection                                               */
    /* ============================================================== */

    _isLightMode() {
        try {
            const scheme = this._interfaceSettings.get_string('color-scheme');
            return scheme === 'prefer-light' || scheme === 'default';
        } catch (e) {
            return false;
        }
    }

    _updateTheme() {
        const isLight = this._isLightMode();
        if (isLight) {
            this.add_style_class_name('light-mode');
            this.remove_style_class_name('dark-mode');
            if (this.menu && this.menu.box) {
                this.menu.box.add_style_class_name('light-mode');
                this.menu.box.remove_style_class_name('dark-mode');
            }
        } else {
            this.add_style_class_name('dark-mode');
            this.remove_style_class_name('light-mode');
            if (this.menu && this.menu.box) {
                this.menu.box.add_style_class_name('dark-mode');
                this.menu.box.remove_style_class_name('light-mode');
            }
        }
        if (this._panelIcon) this._panelIcon.queue_repaint();
        if (this._orreryArea) this._orreryArea.queue_repaint();
    }

    /* ============================================================== */
    /*  Timer Management                                               */
    /* ============================================================== */

    _startTimer() {
        if (this._timerId)
            return;
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _addTooltip(actor, text) {
        let tooltip = null;
        actor.connect('enter-event', () => {
            if (tooltip) return Clutter.EVENT_PROPAGATE;
            const isLight = this._isLightMode();
            tooltip = new St.Label({
                text: text,
                style_class: isLight ? 'gnomeastro-tooltip light-mode' : 'gnomeastro-tooltip dark-mode',
            });
            Main.uiGroup.add_child(tooltip);
            const [stageX, stageY] = actor.get_transformed_position();
            const [w, h] = actor.get_size();
            tooltip.set_position(
                Math.round(stageX + w / 2 - tooltip.width / 2),
                Math.round(stageY - tooltip.height - 6)
            );
            return Clutter.EVENT_PROPAGATE;
        });
        actor.connect('leave-event', () => {
            if (tooltip) {
                tooltip.destroy();
                tooltip = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /* ============================================================== */
    /*  Marquee Ticker (5s fixed pause + continuous scrolling)         */
    /* ============================================================== */

    _startTicker(fullText) {
        this._stopTicker();
        if (!this._statusHeader) return;

        this._statusHeader.clutter_text.line_wrap = false;
        this._statusHeader.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        const textWithSep = fullText + '   •   ';
        const loopText = textWithSep + textWithSep;

        /* Temporarily remove width constraint to measure natural unclipped text width */
        this._statusHeader.width = -1;
        this._statusHeader.set_text(textWithSep);
        const [minW, singleWidth] = this._statusHeader.clutter_text.get_preferred_width(-1);
        const containerW = 232;

        if (singleWidth <= containerW) {
            this._statusHeader.set_text(fullText);
            return;
        }

        /* Set loopText and explicitly set header width to full unclipped width so Clutter renders all text */
        this._statusHeader.set_text(loopText);
        const [minW2, loopWidth] = this._statusHeader.clutter_text.get_preferred_width(-1);
        this._statusHeader.width = Math.ceil(loopWidth + 50);
        this._statusHeader.translation_x = 0;

        let currentX = 0;

        /* Initial 3.5s pause before smooth Carmack continuous infinite scrolling */
        this._tickerPauseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
            this._tickerPauseId = 0;

            /* Smooth 30ms tick = ~33 FPS pixel-by-pixel continuous infinite gliding */
            this._tickerLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                currentX -= 1;
                this._statusHeader.translation_x = currentX;

                if (Math.abs(currentX) >= Math.floor(singleWidth)) {
                    currentX = 0;
                    this._statusHeader.translation_x = 0;
                }
                return GLib.SOURCE_CONTINUE;
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTicker() {
        if (this._tickerPauseId) {
            GLib.source_remove(this._tickerPauseId);
            this._tickerPauseId = 0;
        }
        if (this._tickerLoopId) {
            GLib.source_remove(this._tickerLoopId);
            this._tickerLoopId = 0;
        }
        if (this._statusHeader) {
            this._statusHeader.translation_x = 0;
            this._statusHeader.width = -1;
        }
    }

    /* ============================================================== */
    /*  1-Year Simulation Animation                                    */
    /* ============================================================== */

    _toggleSimulation() {
        if (this._simTimerId) {
            this._pauseSimulation();
        } else {
            this._startSimulation();
        }
    }

    _startSimulation() {
        if (this._simTimerId) return;
        const SIM_STEPS  = 300;  /* 6s animation at 50fps */
        const FADE_STEPS = 20;   /* 0.4s fade-out + 0.4s fade-in */
        const TOTAL       = SIM_STEPS + FADE_STEPS * 2;

        if (this._simStep === undefined || this._simStep >= TOTAL) {
            this._simStep = 0;
            this._simFade = 0.0;
        }

        if (this._playIcon) this._playIcon.icon_name = 'media-playback-pause-symbolic';

        const baseTime = new Date().getTime();
        const yearMs = 365.25 * 86400 * 1000;

        this._simTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            this._simStep++;

            if (this._simStep > TOTAL) {
                /* Animation fully complete */
                this._resetSimulation();
                return GLib.SOURCE_REMOVE;
            }

            if (this._simStep <= SIM_STEPS) {
                /* Phase 1: Normal orbital animation */
                this._simFade = 0.0;
                const progress = this._simStep / SIM_STEPS;
                const simDate = new Date(baseTime + progress * yearMs);

                this._positions = Orbital.getPlanetPositions(simDate);
                this._updateDataForDate(simDate);

            } else if (this._simStep <= SIM_STEPS + FADE_STEPS) {
                /* Phase 2: Fade to black */
                const fadeProgress = (this._simStep - SIM_STEPS) / FADE_STEPS;
                this._simFade = fadeProgress;

            } else if (this._simStep === SIM_STEPS + FADE_STEPS + 1) {
                /* Phase 3: Fully black — swap silently to real-time positions TODAY */
                this._simFade = 1.0;
                const now = new Date();
                this._positions = Orbital.getPlanetPositions(now);
                this._updateDataForDate(now);

            } else {
                /* Phase 4: Fade from black back to real positions */
                const fadeProgress = (this._simStep - SIM_STEPS - FADE_STEPS - 1) / (FADE_STEPS - 1);
                this._simFade = 1.0 - fadeProgress;
            }

            this._orreryArea.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _pauseSimulation() {
        if (this._simTimerId) {
            GLib.source_remove(this._simTimerId);
            this._simTimerId = 0;
        }
        if (this._playIcon) this._playIcon.icon_name = 'media-playback-start-symbolic';
    }

    _resetSimulation() {
        this._pauseSimulation();
        this._simStep = 0;
        this._simFade = 0.0;
        const now = new Date();
        this._positions = Orbital.getPlanetPositions(now);
        this._updateDataForDate(now);
        if (this._orreryArea) this._orreryArea.queue_repaint();
    }

    _isConfigured() {
        const lat = this._settings.get_double('latitude');
        const lon = this._settings.get_double('longitude');
        return (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180);
    }

    _formatNextEvtSingleLine(nextEvt) {
        if (!nextEvt) return '—';
        const dateStr = `${nextEvt.date.getDate()}/${nextEvt.date.getMonth() + 1}`;
        const name = nextEvt.name;
        return `${_(name)} (${dateStr})`;
    }

    _updateDataForDate(date) {
        const lat = this._isConfigured() ? this._settings.get_double('latitude') : 0.0;
        const isNorth = lat >= 0;
        
        this._infoBox.show();

        const closest = Orbital.getClosestPlanet(this._positions);
        const closestText = `${_(closest.name)} (${closest.distance.toFixed(3)} AU)`;
        this._startClosestPlanetTicker(closestText);

        const earthSun = Orbital.getEarthSunDistance(this._positions);
        this._rows.earthSunDist.set_text(`${earthSun.toFixed(4)} AU`);

        const velocity = Orbital.getEarthOrbitalVelocity(date);
        this._rows.orbitalVelocity.set_text(`${velocity.toFixed(2)} km/s`);

        const dayOfYear = Orbital.getDayOfYear(date);
        const totalDays = this._isLeapYear(date.getFullYear()) ? 366 : 365;
        this._rows.dayOfYear.set_text(`${dayOfYear} / ${totalDays}`);

        const seasonKey = Orbital.getAstronomicalSeason(date, isNorth);
        this._rows.season.set_text(_(seasonKey));

        const nextEvt = Orbital.getNextEquinoxSolstice(date, isNorth);
        const eventText = this._formatNextEvtSingleLine(nextEvt);
        this._startNextEventTicker(eventText);
    }

    _startClosestPlanetTicker(fullText) {
        this._stopClosestPlanetTicker();
        const label = this._rows.closestPlanet;
        if (!label) return;

        const valWrapper = label.get_parent();
        const containerW = 95;
        if (valWrapper) {
            valWrapper.width = containerW;
        }

        label.clutter_text.line_wrap = false;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        const textWithSep = fullText + '   •   ';
        const loopText = textWithSep + textWithSep;

        label.width = -1;
        label.set_text(textWithSep);
        const [minW, singleWidth] = label.clutter_text.get_preferred_width(-1);

        if (singleWidth <= containerW) {
            label.set_text(fullText);
            return;
        }

        label.set_text(loopText);
        const [minW2, loopWidth] = label.clutter_text.get_preferred_width(-1);
        label.width = Math.ceil(loopWidth + 50);
        label.translation_x = 0;

        let currentX = 0;

        this._closestPauseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
            this._closestPauseId = 0;

            this._closestLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                currentX -= 1;
                label.translation_x = currentX;

                if (Math.abs(currentX) >= Math.floor(singleWidth)) {
                    currentX = 0;
                    label.translation_x = 0;
                }
                return GLib.SOURCE_CONTINUE;
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _stopClosestPlanetTicker() {
        if (this._closestPauseId) {
            GLib.source_remove(this._closestPauseId);
            this._closestPauseId = 0;
        }
        if (this._closestLoopId) {
            GLib.source_remove(this._closestLoopId);
            this._closestLoopId = 0;
        }
        if (this._rows && this._rows.closestPlanet) {
            this._rows.closestPlanet.translation_x = 0;
            this._rows.closestPlanet.width = -1;
        }
    }

    _startNextEventTicker(fullText) {
        this._stopNextEventTicker();
        const label = this._rows.nextEvent;
        if (!label) return;

        const valWrapper = label.get_parent();
        const containerW = 95;
        if (valWrapper) {
            valWrapper.width = containerW;
        }

        label.clutter_text.line_wrap = false;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        const textWithSep = fullText + '   •   ';
        const loopText = textWithSep + textWithSep;

        /* Temporarily remove width constraint to measure natural unclipped text width */
        label.width = -1;
        label.set_text(textWithSep);
        const [minW, singleWidth] = label.clutter_text.get_preferred_width(-1);

        if (singleWidth <= containerW) {
            label.set_text(fullText);
            return;
        }

        /* Set loopText and explicitly set label width to full unclipped width so Clutter renders all text */
        label.set_text(loopText);
        const [minW2, loopWidth] = label.clutter_text.get_preferred_width(-1);
        label.width = Math.ceil(loopWidth + 50);
        label.translation_x = 0;

        let currentX = 0;

        /* Initial 3.5s pause before smooth Carmack continuous infinite scrolling */
        this._nextEventPauseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
            this._nextEventPauseId = 0;

            /* Smooth 30ms tick = ~33 FPS pixel-by-pixel continuous infinite gliding */
            this._nextEventLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                currentX -= 1;
                label.translation_x = currentX;

                if (Math.abs(currentX) >= Math.floor(singleWidth)) {
                    currentX = 0;
                    label.translation_x = 0;
                }
                return GLib.SOURCE_CONTINUE;
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _stopNextEventTicker() {
        if (this._nextEventPauseId) {
            GLib.source_remove(this._nextEventPauseId);
            this._nextEventPauseId = 0;
        }
        if (this._nextEventLoopId) {
            GLib.source_remove(this._nextEventLoopId);
            this._nextEventLoopId = 0;
        }
        if (this._rows && this._rows.nextEvent) {
            this._rows.nextEvent.translation_x = 0;
            this._rows.nextEvent.width = -1;
        }
    }

    _update() {
        if (this._simTimerId) return;
        const now = new Date();
        this._positions = Orbital.getPlanetPositions(now);

        const lat = this._isConfigured() ? this._settings.get_double('latitude') : 0.0;
        const lon = this._isConfigured() ? this._settings.get_double('longitude') : 0.0;

        /* Status card: single continuous string with 5s pause + marquee ticker */
                if (this._isConfigured()) {
            const visible = Orbital.getVisiblePlanets(this._positions, now, lat, lon);
            if (visible.length > 0) {
                const names = visible.map(n => _(n)).join(', ');
                let suffix = _('above horizon');
                const fullStr = `${names} ${suffix}`;
                if (this.menu.isOpen) {
                    this._startTicker(fullStr);
                } else {
                    this._statusHeader.set_text(fullStr);
                }
                this._statusHeader.show();
            } else {
                let statusText = _('Planets below horizon');
                this._startTicker(statusText);
                this._statusHeader.show();
            }
        } else {
            this._startTicker(_('Coordinates not configured'));
            this._statusHeader.show();
        }

        /* Info rows - ALWAYS show data */
        this._updateDataForDate(now);

        /* Trigger repaint */
        this._panelIcon.queue_repaint();
        this._orreryArea.queue_repaint();
    }

    _isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    }

    /* ============================================================== */
    /*  Hover Detection                                                */
    /* ============================================================== */

    _checkHover(mx, my) {
        let found = null;
        for (const pp of this._planetScreenPositions) {
            const dx = mx - pp.sx;
            const dy = my - pp.sy;
            if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS) {
                found = pp.name;
                break;
            }
        }
        if (found !== this._hoveredPlanet) {
            this._hoveredPlanet = found;
            if (found !== null) {
                global.display.set_cursor(Meta.Cursor.POINTING_HAND);
            } else {
                global.display.set_cursor(Meta.Cursor.DEFAULT);
            }
            this._orreryArea.queue_repaint();
        }
    }

    /* ============================================================== */
    /*  Cairo: Panel Icon (Small Orrery Symbol)                        */
    /* ============================================================== */

    _drawPanelIcon(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        const cx = w / 2;
        const cy = h / 2;

        cr.setOperator(0); // CLEAR
        cr.paint();
        cr.setOperator(2); // OVER

        /* 1. Sol central brillante (círculo relleno en el centro) */
        cr.setSourceRGBA(1.0, 1.0, 1.0, 1.0);
        cr.arc(cx, cy, 3.5, 0, TWO_PI);
        cr.fill();

        /* 2. Círculo concéntrico perfecto (órbita) aprovechando el máximo espacio del icono (radio 8.8px) */
        const rEarth = 8.8;
        cr.setLineWidth(0.9);
        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.45);
        cr.arc(cx, cy, rEarth, 0, TWO_PI);
        cr.stroke();

        /* 3. La Tierra (punto pequeño nítido en su posición heliocéntrica real) */
        if (this._positions) {
            const earth = this._positions.find(p => p.name === 'Earth');
            if (earth) {
                const angle = Math.atan2(earth.y, earth.x);
                const px = cx + rEarth * Math.cos(angle);
                const py = cy + rEarth * Math.sin(angle);
                cr.setSourceRGBA(1.0, 1.0, 1.0, 1.0);
                cr.arc(px, py, 1.5, 0, TWO_PI);
                cr.fill();
            }
        }

        cr.$dispose();
    }

    /* ============================================================== */
    /*  Cairo: Orrery Diagram (Popup)                                  */
    /* ============================================================== */

    _drawOrrery(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        cr.setOperator(0); // CLEAR
        cr.paint();
        cr.setOperator(2); // OVER

        /* Background container (GNOME Official Palette: #000000 dark / #b8b8b8 light) */
        const isLight = this._isLightMode();
        if (isLight) {
            cr.setSourceRGBA(0.72, 0.72, 0.72, 1.0);
        } else {
            cr.setSourceRGBA(...C.diagBg);
        }
        const bgR = 10;
        cr.newPath();
        cr.arc(bgR,     bgR,     bgR, Math.PI, 1.5 * Math.PI);
        cr.arc(w - bgR, bgR,     bgR, 1.5 * Math.PI, TWO_PI);
        cr.arc(w - bgR, h - bgR, bgR, 0, 0.5 * Math.PI);
        cr.arc(bgR,     h - bgR, bgR, 0.5 * Math.PI, Math.PI);
        cr.closePath();
        cr.fill();

        /* Diagram center & radius (88px radius / 176px diameter, 1:1 match with Sun & Moon) */
        const cx = w / 2;
        const cy = h / 2;
        const maxR = Math.min(w, h) / 2 - 32;

        if (!this._positions) {
            cr.setSourceRGBA(0.6, 0.6, 0.6, 0.5);
            cr.selectFontFace('Sans', 0, 1);
            cr.setFontSize(28);
            const ext = cr.textExtents('?');
            cr.moveTo(cx - ext.width / 2, cy + ext.height / 2);
            cr.showText('?');
            cr.$dispose();
            return;
        }

        /*
         * Scale: Split-linear.
         * Inner planets (Mercury-Mars, < 2 AU) → 45% of radius
         * Outer planets (Jupiter-Neptune, 2-30 AU) → 55% of radius
         */
        const INNER_CUTOFF = 1.8;   /* AU — Mars orbit ~1.52 AU */
        const OUTER_MAX    = 30.5;  /* AU — Neptune orbit ~30.07 AU */
        const INNER_FRAC   = 0.45;

        const _auToR = (au) => {
            let baseR;
            if (au <= INNER_CUTOFF) {
                baseR = (au / INNER_CUTOFF) * INNER_FRAC * maxR;
            } else {
                const outerNorm = (au - INNER_CUTOFF) / (OUTER_MAX - INNER_CUTOFF);
                baseR = (INNER_FRAC + outerNorm * (1.0 - INNER_FRAC)) * maxR;
            }
            return baseR * this._zoom;
        };

        /* ---- Orbit rings (solid fine lines) ---- */
        if (isLight) {
            cr.setSourceRGBA(0.36, 0.38, 0.42, 0.65);
        } else {
            cr.setSourceRGBA(...C.orbitRing);
        }
        cr.setLineWidth(0.6);
        cr.setDash([], 0);

        /* Semi-major axes in AU for orbit rings */
        const orbits = [0.387, 0.723, 1.000, 1.524, 5.203, 9.537, 19.19, 30.07];
        for (const a of orbits) {
            const r = _auToR(a);
            cr.arc(cx, cy, r, 0, TWO_PI);
            cr.stroke();
        }
        cr.setDash([], 0);

        /* ---- Sun at center (Enlarged & Glowing with Zoom) ---- */
        const sunScale = Math.min(2.0, Math.max(0.7, Math.sqrt(this._zoom)));
        cr.setSourceRGBA(1.0, 0.95, 0.7, 0.08);
        cr.arc(cx, cy, 22 * sunScale, 0, TWO_PI);
        cr.fill();
        cr.setSourceRGBA(1.0, 0.95, 0.6, 0.18);
        cr.arc(cx, cy, 16 * sunScale, 0, TWO_PI);
        cr.fill();
        cr.setSourceRGBA(1.0, 0.95, 0.8, 0.35);
        cr.arc(cx, cy, 11 * sunScale, 0, TWO_PI);
        cr.fill();
        cr.setSourceRGBA(...C.sunCore);
        cr.arc(cx, cy, 7.5 * sunScale, 0, TWO_PI);
        cr.fill();

        /* ---- Draw planets ---- */
        this._planetScreenPositions = [];

        for (const p of this._positions) {
            const dist = Math.sqrt(p.x * p.x + p.y * p.y);
            const r = _auToR(dist);
            const angle = Math.atan2(p.y, p.x);

            const sx = cx + r * Math.cos(angle);
            const sy = cy + r * Math.sin(angle);

            /* Store screen position for hover detection */
            this._planetScreenPositions.push({name: p.name, sx, sy});

            /* Planet dot size (Sun is 7.5px, so Jupiter is 3.8px, Earth 2.4px, Mercury 1.5px) */
            const dotR = p.name === 'Jupiter' ? 3.8
                       : p.name === 'Saturn'  ? 3.2
                       : p.name === 'Uranus' || p.name === 'Neptune' ? 2.6
                       : p.name === 'Earth'   ? 2.4
                       : p.name === 'Venus'   ? 2.2
                       : p.name === 'Mars'    ? 1.8
                       : 1.5; /* Mercury */

            /* Planet colour (25% darker tone in Light Mode for clarity against #b8b8b8) */
            const pColor = isLight
                ? [p.color[0] * 0.75, p.color[1] * 0.75, p.color[2] * 0.75, 1.0]
                : p.color;

            cr.setSourceRGBA(...pColor);
            cr.arc(sx, sy, dotR, 0, TWO_PI);
            cr.fill();

            /* Saturn: tiny ring */
            if (p.name === 'Saturn') {
                cr.setSourceRGBA(pColor[0], pColor[1], pColor[2], 0.6);
                cr.setLineWidth(1.0);
                cr.save();
                cr.translate(sx, sy);
                cr.scale(1.0, 0.35);
                cr.arc(0, 0, dotR + 2.5, 0, TWO_PI);
                cr.restore();
                cr.stroke();
            }

            /* Earth: crosshair "you are here" */
            if (p.name === 'Earth') {
                cr.setSourceRGBA(...C.earthCross);
                cr.setLineWidth(0.6);
                cr.moveTo(sx - 5, sy);
                cr.lineTo(sx + 5, sy);
                cr.stroke();
                cr.moveTo(sx, sy - 5);
                cr.lineTo(sx, sy + 5);
                cr.stroke();
            }

            /* Hover: show planet name tooltip */
            if (this._hoveredPlanet === p.name) {
                const label = _(p.name);
                cr.setSourceRGBA(0.12, 0.16, 0.23, 0.90);
                cr.selectFontFace('Sans', 0, 1); // Bold
                cr.setFontSize(10);
                const ext = cr.textExtents(label);

                const tooltipW = ext.width + 12;
                const tooltipH = 18;
                let tx = sx - tooltipW / 2;
                let ty = sy - dotR - tooltipH - 4;

                /* Clamp tooltip inside canvas */
                tx = Math.max(4, Math.min(w - tooltipW - 4, tx));
                ty = Math.max(4, ty);

                /* Tooltip background */
                this._roundRect(cr, tx, ty, tooltipW, tooltipH, 4);
                cr.fill();

                /* Tooltip text */
                cr.setSourceRGBA(1.0, 1.0, 1.0, 0.95);
                cr.moveTo(tx + 6, ty + 13);
                cr.showText(label);
            }
        }

        /* ---- Explanatory text / Zoom indicator at bottom / top ---- */
        if (Math.abs(this._zoom - 1.0) > 0.05) {
            cr.setSourceRGBA(1.0, 1.0, 1.0, 0.4);
            cr.selectFontFace('Sans', 0, 1);
            cr.setFontSize(9);
            const zoomStr = `${this._zoom.toFixed(1)}x`;
            const extZ = cr.textExtents(zoomStr);
            cr.moveTo(w - extZ.width - 12, 18);
            cr.showText(zoomStr);
        }

        /* ---- Simulation fade overlay (matches canvas background) ---- */
        if (this._simFade > 0.001) {
            if (isLight) {
                cr.setSourceRGBA(0.72, 0.72, 0.72, this._simFade);
            } else {
                cr.setSourceRGBA(0.0, 0.0, 0.0, this._simFade);
            }
            cr.newPath();
            cr.arc(bgR,     bgR,     bgR, Math.PI, 1.5 * Math.PI);
            cr.arc(w - bgR, bgR,     bgR, 1.5 * Math.PI, TWO_PI);
            cr.arc(w - bgR, h - bgR, bgR, 0, 0.5 * Math.PI);
            cr.arc(bgR,     h - bgR, bgR, 0.5 * Math.PI, Math.PI);
            cr.closePath();
            cr.fill();
        }

        /* Heartbeat indicator */
        const alpha = 0.325 + 0.175 * Math.sin(Date.now() / 1000 * Math.PI);
        if (isLight) {
            cr.setSourceRGBA(0.18, 0.20, 0.21, alpha);
        } else {
            cr.setSourceRGBA(1.0, 1.0, 1.0, alpha);
        }
        cr.arc(w - 12, h - 12, 2.5, 0, TWO_PI);
        cr.fill();

        cr.$dispose();
    }

    /* ============================================================== */
    /*  Utility: Rounded Rectangle                                     */
    /* ============================================================== */

    _roundRect(cr, x, y, w, h, r) {
        cr.newPath();
        cr.arc(x + r,     y + r,     r, Math.PI, 1.5 * Math.PI);
        cr.arc(x + w - r, y + r,     r, 1.5 * Math.PI, TWO_PI);
        cr.arc(x + w - r, y + h - r, r, 0, 0.5 * Math.PI);
        cr.arc(x + r,     y + h - r, r, 0.5 * Math.PI, Math.PI);
        cr.closePath();
    }

    /* ============================================================== */
    /*  Cleanup                                                        */
    /* ============================================================== */

    destroy() {
        if (this._themeSettingsId && this._interfaceSettings) {
            this._interfaceSettings.disconnect(this._themeSettingsId);
            this._themeSettingsId = 0;
        }
        this._pauseSimulation();
        this._stopTimer();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }
});

/* ================================================================== */
/*  Extension Entry Point                                               */
/* ================================================================== */

export default class GnomePlanetariumExtension extends Extension {

    enable() {
        this.initTranslations();
        this._indicator = new OrreryIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._orderTrio();
    }

    _orderTrio() {
        try {
            const rightBox = Main.panel._rightBox;
            const sa = Main.panel.statusArea;

            const sunActor = (sa['gnomesunextension@aiurri.xyz'] || sa['gnomesun@aiurri.xyz'])?.container ||
                             (sa['gnomesunextension@aiurri.xyz'] || sa['gnomesun@aiurri.xyz']);
            const moonActor = (sa['gnomemoonextension@aiurri.xyz'] || sa['gnomemoon@aiurri.xyz'])?.container ||
                              (sa['gnomemoonextension@aiurri.xyz'] || sa['gnomemoon@aiurri.xyz']);
            const planActor = (sa['gnomeplanetariumextension@aiurri.xyz'] || sa['gnomeorrery@aiurri.xyz'])?.container ||
                              (sa['gnomeplanetariumextension@aiurri.xyz'] || sa['gnomeorrery@aiurri.xyz']);

            if (sunActor && moonActor)
                rightBox.set_child_above_sibling(moonActor, sunActor);
            if (moonActor && planActor)
                rightBox.set_child_above_sibling(planActor, moonActor);
            else if (sunActor && planActor)
                rightBox.set_child_above_sibling(planActor, sunActor);
        } catch (e) {}
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
