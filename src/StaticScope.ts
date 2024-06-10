import { wrap, indexToFreq } from "./utils";
import "./StaticScope.scss";

enum EScopeMode {
    Data = 0,
    Interleaved = 1,
    Oscilloscope = 2,
    Spectroscope = 3,
    Spectrogram = 4
}
type TOptions = {
    container: HTMLDivElement;
    type?: EScopeMode;
};
type TStatsToDraw = {
    x?: number;
    y?: number;
    xLabel?: string;
    yLabel?: string;
    values: number[];
};

export class TXLogMode {
    _logBase: 0 | 2 | 10;
    _logFunc?: any;
    constructor(base: 0 | 2 | 10) {
        this._logBase = base;
        if (base) this._logFunc = base === 2 ? Math.log2 : Math.log10;
    }
    get logBase() { return this._logBase; }
    get logFunc() { return this._logFunc; }
    getPowerSteps(sampleRate: number): { powers: number; suffixSteps: number; interPowerFactor: number } {
        const nyquist = sampleRate / 2;
        let powers = 0;
        for (; this.logBase ** powers < nyquist; powers++);
        powers -= 1;
        let suffixSteps = 1;
        const lastPower = this.logBase ** powers;
        for (; lastPower + (lastPower * suffixSteps) < nyquist; suffixSteps++);
        const interPowerFactor = 1 / (powers + this.logFunc(suffixSteps + 2));
        return {
            powers,
            suffixSteps,
            interPowerFactor
        };
    }
}

export type TDrawOptions = {
    drawMode: "offline" | "continuous" | "onevent" | "manual";
    $: number; // start sample index
    $buffer: number; // start buffer index
    t?: Float32Array[]; // Time domain data
    f?: Float32Array[]; // Freq domain data
    e?: { type: string; data: any }[][]; // events of each buffer
    bufferSize: number;
    fftSize: number;
    fftOverlap: 1 | 2 | 4 | 8;
    freqEstimated?: number;
    sampleRate?: number;
    xLogMode?: TXLogMode;
}

export class StaticScope {
    raf: number;
    ctx: CanvasRenderingContext2D;
    container: HTMLDivElement;
    canvas: HTMLCanvasElement;
    btnSwitch: HTMLButtonElement;
    btnZoomOut: HTMLButtonElement;
    btnZoom: HTMLButtonElement;
    btnZoomIn: HTMLButtonElement;
    btnDownload: HTMLButtonElement;
    iSwitch: HTMLElement;
    spanSwitch: HTMLSpanElement;
    divData: HTMLDivElement;
    divDefault: HTMLDivElement;
    private _mode = EScopeMode.Oscilloscope;
    private _zoom = { oscilloscope: 1, spectroscope: 1, spectrogram: 1 };
    private _vzoom = { oscilloscope: 1, spectroscope: 1, spectrogram: 1 };
    private _zoomOffset = { oscilloscope: 0, spectroscope: 0, spectrogram: 0 };
    data: TDrawOptions = { drawMode: "manual", t: undefined, $: 0, $buffer: 0, bufferSize: 128, fftSize: 256, fftOverlap: 2, xLogMode: new TXLogMode(0) };
    cursor: { x: number; y: number };
    dragging: boolean = false;
    spectTempCtx: CanvasRenderingContext2D;
    lastSpect$: number = 0;
    drawSpectrogram: boolean = false;
    newDataArrived: boolean = false;

    handleMouseMove = (e: MouseEvent | TouchEvent) => {
        if (!this.data || !this.data.t || !this.data.t.length || !this.data.t[0].length) return;
        if (this.mode === EScopeMode.Data) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const rect = this.canvas.getBoundingClientRect();
        let x = e instanceof MouseEvent ? e.offsetX : e.touches[0].pageX - rect.left;
        x = Math.max(0, Math.min(w, x));
        let y = e instanceof MouseEvent ? e.offsetY : e.touches[0].pageY - rect.top;
        y = Math.max(0, Math.min(h, y));
        this.cursor = { x, y };
        // if (this.data.drawMode === "continuous") return;
        this.draw();
    }
    handleMouseDown = (eDown: MouseEvent | TouchEvent) => {
        if (!this.data || !this.data.t || !this.data.t.length || !this.data.t[0].length) return;
        if (this.mode === EScopeMode.Data) return;
        eDown.preventDefault();
        eDown.stopPropagation();
        this.dragging = true;
        this.canvas.style.cursor = "grab";
        const origZoom = this.zoom;
        const origOffset = this.zoomOffset;
        let prevX = eDown instanceof MouseEvent ? eDown.pageX : eDown.touches[0].pageX;
        // let prevY = eDown instanceof MouseEvent ? eDown.pageY : eDown.touches[0].pageY;
        const handleMouseMove = (eMove: MouseEvent | TouchEvent) => {
            const x = eMove instanceof MouseEvent ? eMove.pageX : eMove.touches[0].pageX;
            // const y = eMove instanceof MouseEvent ? eMove.pageY : eMove.touches[0].pageY;
            const dX = x - prevX;
            // const dY = y - prevY;
            prevX = x;
            // prevY = y;
            // const multiplier = 1 / 1.015 ** dY;
            const offset = -dX / this.zoom / this.canvas.width;
            // if (multiplier !== 1) this.zoom *= multiplier;
            if (offset !== 0) this.zoomOffset += offset;
            if (this.zoom !== origZoom || this.zoomOffset !== origOffset) this.draw();
        };
        const handleMouseUp = () => {
            this.dragging = false;
            this.canvas.style.cursor = "";
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("touchmove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.removeEventListener("touchend", handleMouseUp);
        };
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("touchmove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        document.addEventListener("touchend", handleMouseUp);
    }
    handleMouseLeave = () => {
        if (!this.data || !this.data.t || !this.data.t.length || !this.data.t[0].length) return;
        if (this.mode === EScopeMode.Data) return;
        this.cursor = undefined;
        this.draw();
    }
    static drawInterleaved(ctx: CanvasRenderingContext2D, w: number, h: number, d: TDrawOptions, zoom: number, zoomOffset: number, vzoom: number, cursor?: { x: number; y: number }) {
        this.drawBackground(ctx, w, h);
        if (!d) return;
        const { $, t, freqEstimated, sampleRate, drawMode } = d;
        if (!t || !t.length || !t[0].length) return;
        const l = t[0].length;
        // Fastest way to get min and max to have: 1. max abs value for y scaling, 2. mean value for zero-crossing
        let min = t[0][0];
        let max = t[0][0];
        let i = t.length;
        let samp: number;
        while (i--) {
            let j = l;
            while (j--) {
                samp = t[i][j];
                if (samp < min) min = samp;
                else if (samp > max) max = samp;
            }
        }
        const yFactor = Math.max(1, Math.abs(min), Math.abs(max)) * vzoom;
        let $0 = 0; // Draw start
        let $1 = l - 1; // Draw End
        let $zerox = 0;
        if (drawMode === "continuous" && l < sampleRate) { // Stablize when window size < 1 sec
            const thresh = (min + max) * 0.5 + 0.001; // the zero-crossing with "offset"
            const period = sampleRate / freqEstimated;
            const times = Math.floor(l / period) - 1;
            while (t[0][wrap($zerox++, $, l)] > thresh && $zerox < l);
            if ($zerox >= l - 1) {
                $zerox = 0;
            } else {
                while (t[0][wrap($zerox++, $, l)] < thresh && $zerox < l);
                if ($zerox >= l - 1) {
                    $zerox = 0;
                }
            }
            const drawL = times > 0 && isFinite(period) ? Math.min(period * times, l - $zerox) : l - $zerox;
            $0 = Math.round($zerox + drawL * zoomOffset);
            $1 = Math.round($zerox + drawL / zoom + drawL * zoomOffset);
        } else {
            $0 = Math.round(l * zoomOffset);
            $1 = Math.round(l / zoom + l * zoomOffset);
        }
        const left = 50;
        const bottom = 20;
        const hCh = (h - bottom) / t.length; // Height per channel
        const eventsToDraw = this.drawGrid(ctx, w, h, $0 - $zerox, $1 - $zerox, $zerox, yFactor, d, EScopeMode.Interleaved);
        const gridX = (w - left) / ($1 - $0 - 1);
        const step = Math.max(1, Math.round(1 / gridX)); // horizontal draw step for optimization
        ctx.lineWidth = 2;
        for (let i = 0; i < t.length; i++) {
            ctx.beginPath();
            ctx.strokeStyle = `hsl(${i * 60}, 100%, 85%)`;
            let maxInStep: number;
            let minInStep: number;
            let $j: number;
            let $step: number;
            let x: number;
            let y: number;
            for (let j = $0; j < $1; j++) {
                $j = wrap(j, $, l); // True index
                samp = t[i][$j];
                $step = (j - $0) % step;
                if ($step === 0) {
                    maxInStep = samp;
                    minInStep = samp;
                } else {
                    if (samp > maxInStep) maxInStep = samp;
                    if (samp < minInStep) minInStep = samp;
                }
                if ($step !== step - 1) continue;
                x = (j - $0) * gridX + left;
                y = hCh * (i + 0.5 - maxInStep / yFactor * 0.5);
                if (j === $0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                if (minInStep !== maxInStep) {
                    y = hCh * (i + 0.5 - minInStep / yFactor * 0.5);
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
        }
        eventsToDraw.forEach(params => this.drawEvent(ctx, w, h, ...params));
        if (cursor && cursor.x > left && cursor.y < h - bottom) {
            const statsToDraw: TStatsToDraw = { values: [] };
            const $cursor = Math.round($0 + (cursor.x - left) / gridX);
            statsToDraw.values = [];
            statsToDraw.x = ($cursor - $0) * gridX + left;
            statsToDraw.xLabel = ($cursor - $zerox).toFixed(0);
            const $j = wrap($cursor, $, l);
            for (let i = 0; i < t.length; i++) {
                const samp = t[i][$j];
                if (typeof samp === "number") statsToDraw.values.push(samp);
            }
            this.drawStats(ctx, w, h, statsToDraw);
        }
    }
    static drawOscilloscope(ctx: CanvasRenderingContext2D, w: number, h: number, d: TDrawOptions, zoom: number, zoomOffset: number, vzoom: number, cursor?: { x: number; y: number }) {
        this.drawBackground(ctx, w, h);
        if (!d) return;
        const { $, t, freqEstimated, sampleRate, drawMode } = d;
        if (!t || !t.length || !t[0].length) return;
        const l = t[0].length;
        // Fastest way to get min and max to have: 1. max abs value for y scaling, 2. mean value for zero-crossing
        let min = t[0][0];
        let max = t[0][0];
        let i = t.length;
        let samp: number;
        while (i--) {
            let j = l;
            while (j--) {
                samp = t[i][j];
                if (samp < min) min = samp;
                else if (samp > max) max = samp;
            }
        }
        const yFactor = Math.max(1, Math.abs(min), Math.abs(max)) * vzoom;
        let $0 = 0; // Draw start
        let $1 = l - 1; // Draw End
        let $zerox = 0;
        if (drawMode === "continuous" && l < sampleRate) { // Stablize when window size < 1 sec
            const thresh = (min + max) * 0.5 + 0.001; // the zero-crossing with "offset"
            const period = sampleRate / freqEstimated;
            const times = Math.floor(l / period) - 1;
            while (t[0][wrap($zerox++, $, l)] > thresh && $zerox < l); // Find first raise
            if ($zerox >= l - 1) { // Found nothing, no stablization
                $zerox = 0;
            } else {
                while (t[0][wrap($zerox++, $, l)] < thresh && $zerox < l); // Find first drop
                if ($zerox >= l - 1) {
                    $zerox = 0;
                }
            }
            const drawL = times > 0 && isFinite(period) ? Math.min(period * times, l - $zerox) : l - $zerox; // length to draw
            $0 = Math.round($zerox + drawL * zoomOffset);
            $1 = Math.round($zerox + drawL / zoom + drawL * zoomOffset);
        } else {
            $0 = Math.round(l * zoomOffset);
            $1 = Math.round(l / zoom + l * zoomOffset);
        }
        const left = 50;
        const bottom = 20;
        const eventsToDraw = this.drawGrid(ctx, w, h, $0 - $zerox, $1 - $zerox, $zerox, yFactor, d, EScopeMode.Oscilloscope);
        const gridX = (w - left) / ($1 - $0 - 1);
        const step = Math.max(1, Math.round(1 / gridX));
        ctx.lineWidth = 2;
        for (let i = 0; i < t.length; i++) {
            ctx.beginPath();
            ctx.strokeStyle = t.length === 1 ? "white" : `hsl(${i * 60}, 100%, 85%)`;
            let maxInStep: number;
            let minInStep: number;
            let $j: number;
            let $step: number;
            let x: number;
            let y: number;
            for (let j = $0; j < $1; j++) {
                $j = wrap(j, $, l);
                samp = t[i][$j];
                $step = (j - $0) % step;
                if ($step === 0) {
                    maxInStep = samp;
                    minInStep = samp;
                } else {
                    if (samp > maxInStep) maxInStep = samp;
                    if (samp < minInStep) minInStep = samp;
                }
                if ($step !== step - 1) continue;
                x = (j - $0) * gridX + left;
                y = (h - bottom) * (0.5 - maxInStep / yFactor * 0.5);
                if (j === $0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                if (minInStep !== maxInStep) {
                    y = (h - bottom) * (0.5 - minInStep / yFactor * 0.5);
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
        }
        eventsToDraw.forEach(params => this.drawEvent(ctx, w, h, ...params));
        if (cursor && cursor.x > left && cursor.y < h - bottom) {
            const statsToDraw: TStatsToDraw = { values: [] };
            const $cursor = Math.round($0 + (cursor.x - left) / gridX);
            statsToDraw.values = [];
            statsToDraw.x = ($cursor - $0) * gridX + left;
            statsToDraw.xLabel = ($cursor - $zerox).toFixed(0);
            const $j = wrap($cursor, $, l);
            for (let i = 0; i < t.length; i++) {
                const samp = t[i][$j];
                if (typeof samp === "number") statsToDraw.values.push(samp);
            }
            this.drawStats(ctx, w, h, statsToDraw);
        }
    }
    static drawSpectroscope(
        canvas: CanvasRenderingContext2D, // canvas for the scope
        canvasWidth: number, // width of the canvas
        canvasHeight: number, // height of the canvas
        drawOptions: TDrawOptions, // Current draw options
        zoom: number, // Current zoom factor
        zoomOffset: number, // Zoom offset
        cursor?: { x: number; y: number } // Optional cursor position
    ) {
        // Fill the background
        this.drawBackground(canvas, canvasWidth, canvasHeight);
        // If we have no TDrawOptions then bug out
        if (!drawOptions) return;
        // Get the draw options that interest us:
        const {
            $, // Start sample index
            f, // Frequency-domain data [f[n] has channel-n data, f.length is number of channels]
            fftSize, // fft block size (2**n where n can be 8 thru 16)
            fftOverlap, // fft overlap (2**m where m can be 0 thru 3)
            xLogMode, // Whether using linear or logarithmic scaling on the X axis
            sampleRate
        } = drawOptions;

        // If there isn't any usable data, then bug out
        if (!f /* no data */|| !f.length /* no channels */ || !f[0].length /* no data in channels */) return;

        const channels = f.length;

        // The number of frequencies we have data for
        const fftBins = fftSize / 2;

        // l is the length data
        const dataPtsPerChannel = f[0].length;

        const yAxisFromLeft = 50;
        const xAxisFromBottom = 20;
        const xWidth = canvasWidth - yAxisFromLeft;
        const channelHeight = (canvasHeight - xAxisFromBottom) / channels;

        // The Log10/2 stuff
        const {
            logBase,
            logFunc
        } = xLogMode;

        // Derive the start and end indexes we are REALLY dealing with
        const samplesStart = dataPtsPerChannel - fftBins + Math.round(fftBins * zoomOffset);
        const samplesEnd = dataPtsPerChannel - fftBins + Math.round(fftBins / zoom + fftBins * zoomOffset);
        const sampleCount = samplesEnd - samplesStart - 1;

        // get the "events to draw"
        const eventsToDraw = this.drawGrid(
            canvas, // The canvas
            canvasWidth, //   The canvas width
            canvasHeight, //   The canvas height
            samplesStart,
            samplesEnd,
            0, //   The X scale zero
            1, //   The Y scale factor
            drawOptions, //   The draw options
            EScopeMode.Spectroscope, // the type of scope we are drawing
            xLogMode
        );

        let startOfBins = $ * fftOverlap / 2;
        startOfBins -= startOfBins % fftBins;

        const xWidthPerSample = xWidth / sampleCount;
        const samplesPerXStep = Math.max(1, Math.round(1 / xWidthPerSample));
        // For each channel...
        for (let channel = 0; channel < channels; channel++) {
            let maxInStep = 0;

            canvas.beginPath();
            canvas.strokeStyle = channels === 1 ? "white" : `hsl(${channel * 60}, 100%, 85%)`;
            if (logBase) {
                const { interPowerFactor } = xLogMode.getPowerSteps(sampleRate);
                const pixelsPerPower = xWidth * interPowerFactor;

                const lastSample = samplesEnd - samplesStart - 1;
                let nextX = 0;
                for (let j = samplesStart; j < samplesEnd; j++) {
                    const relativeIndex = j - samplesStart;

                    const frequency = indexToFreq(j, fftBins, drawOptions.sampleRate);
                    const x = logFunc(frequency) * pixelsPerPower + yAxisFromLeft;

                    const sample = f[channel][wrap(j, startOfBins, dataPtsPerChannel)];
                    if (maxInStep === 0) maxInStep = sample;

                    if (x < nextX && relativeIndex < lastSample) {
                        if (sample > maxInStep) maxInStep = sample;
                        continue;
                    }

                    const y = channelHeight * (channel + 1 - Math.min(1, Math.max(0, maxInStep / 100 + 1)));
                    if (y > 1) {
                        canvas.beginPath();
                        canvas.moveTo(x, y);
                        canvas.lineTo(x, y - 1);
                        canvas.stroke();
                    }
                    nextX = x + xWidthPerSample;
                    maxInStep = 0;
                }
                // canvas.lineTo(canvasWidth, channelHeight * (channel + 1));
                // canvas.lineTo(yAxisFromLeft, channelHeight * (channel + 1));
                // canvas.stroke();
            } else {
                canvas.fillStyle = channels === 1 ? "white" : `hsl(${channel * 60}, 100%, 85%)`;
                for (let j = samplesStart; j < samplesEnd; j++) {
                    const relativeIndex = j - samplesStart;
                    const $j = wrap(j, startOfBins, dataPtsPerChannel);
                    const sample = f[channel][$j];
                    const $step = relativeIndex % samplesPerXStep;
                    // First sample in step
                    if ($step === 0) maxInStep = sample;

                    // Not last sample in step sample in step
                    if ($step !== samplesPerXStep - 1) {
                        if ($step !== 0 && sample > maxInStep) maxInStep = sample;
                        continue;
                    }
                    const x = relativeIndex * xWidthPerSample + yAxisFromLeft;
                    const y = channelHeight * (channel + 1 - Math.min(1, Math.max(0, maxInStep / 100 + 1)));
                    if (j === samplesStart) canvas.moveTo(x, y);
                    else canvas.lineTo(x, y);
                }
                canvas.lineTo(canvasWidth, channelHeight * (channel + 1));
                canvas.lineTo(yAxisFromLeft, channelHeight * (channel + 1));
                canvas.closePath();
                canvas.fill();
            }
        }
        eventsToDraw.forEach(params => this.drawEvent(canvas, canvasWidth, canvasHeight, ...params));
        if (cursor && cursor.x > yAxisFromLeft && cursor.y < canvasHeight - xAxisFromBottom) {
            const statsToDraw: TStatsToDraw = { values: [] };
            const relativeCursorX = cursor.x - yAxisFromLeft;
            statsToDraw.values = [];
            // "j" as above - the index of the sample - re-derived from where the cursor is
            const j = samplesStart + Math.round((cursor.x - yAxisFromLeft) / xWidthPerSample);
            if (logBase) {
                const { interPowerFactor } = xLogMode.getPowerSteps(sampleRate);
                const pixelsPerPower = xWidth * interPowerFactor;
                const freq = logBase ** (relativeCursorX / pixelsPerPower);
                // We don't have to fudge because we get a pretty accurate frequency from x
                statsToDraw.x = cursor.x;
                statsToDraw.xLabel = freq.toFixed(0);
            } else {
                // Fudge draw point a bit to take into account rounding
                statsToDraw.x = (j - samplesStart) * xWidthPerSample + yAxisFromLeft;
                statsToDraw.xLabel = indexToFreq(j, fftBins, drawOptions.sampleRate).toFixed(0);
            }
            const $j = wrap(j, startOfBins, dataPtsPerChannel);
            for (let i = 0; i < f.length; i++) {
                const samp = f[i][$j];
                if (typeof samp === "number") statsToDraw.values.push(samp);
            }
            this.drawStats(canvas, canvasWidth, canvasHeight, statsToDraw);
        }
    }
    static drawSpectrogram(ctx: CanvasRenderingContext2D, tempCtx: CanvasRenderingContext2D, w: number, h: number, d: TDrawOptions, zoom: number, zoomOffset: number, cursor?: { x: number; y: number }) {
        this.drawBackground(ctx, w, h);
        if (!d) return;
        const { $, f, fftSize, fftOverlap } = d;
        if (!f || !f.length || !f[0].length) return;
        const fftBins = fftSize / 2;
        let $f = $ * fftOverlap / 2;
        $f -= $f % fftBins;
        const l = f[0].length / fftBins;
        const $0fft = Math.floor(l * zoomOffset);
        const $1fft = Math.ceil(l / zoom + l * zoomOffset);
        const $0 = $0fft * fftBins;
        const $1 = $1fft * fftBins;
        const eventsToDraw = this.drawGrid(ctx, w, h, $0, $1, 0, 1, d, EScopeMode.Spectrogram);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.imageSmoothingEnabled = false;
        const left = 50;
        const bottom = 20;
        const $0src = wrap($0fft, $f / fftBins, l);
        const $1src = $0src + $1fft - $0fft;
        if ($1src > l) {
            const split$ = l - $0src;
            ctx.drawImage(tempCtx.canvas, $0src, 0, split$, tempCtx.canvas.height, left, 0, split$ / ($1src - $0src) * (w - left), h - bottom);
            ctx.drawImage(tempCtx.canvas, 0, 0, $1src - l - 0.01, tempCtx.canvas.height, split$ / ($1src - $0src) * (w - left) + left, 0, (1 - split$ / ($1src - $0src)) * (w - left), h - bottom);
        } else {
            ctx.drawImage(tempCtx.canvas, $0src, 0, $1src - $0src, tempCtx.canvas.height, left, 0, w - left, h - bottom);
        }
        ctx.restore();
        eventsToDraw.forEach(params => this.drawEvent(ctx, w, h, ...params));
        if (cursor && cursor.x > left && cursor.y < h - bottom) {
            const statsToDraw: TStatsToDraw = { values: [] };
            const gridX = (w - left) / ($1fft - $0fft);
            const gridY = (h - bottom) / f.length / fftBins;
            const $fft = $0fft + Math.floor((cursor.x - left) / gridX);
            const $ch = Math.floor(cursor.y / gridY / fftBins);
            const $bin = Math.floor((h - bottom - cursor.y) / gridY) % fftBins;
            const $cursor = $fft * fftBins + $bin;
            const $j = wrap($cursor, $f, f[0].length);
            const freq = ($j % fftBins) / fftBins * d.sampleRate / 2;
            const samp = f[$ch][$j];
            if (typeof samp === "number") statsToDraw.values = [samp];
            statsToDraw.x = ($fft - $0fft + 0.5) * gridX + left;
            statsToDraw.y = (($ch + 1) * fftBins - $bin) * gridY;
            statsToDraw.xLabel = $fft.toFixed(0);
            statsToDraw.yLabel = freq.toFixed(0);
            this.drawStats(ctx, w, h, statsToDraw);
        }
    }
    static drawOfflineSpectrogram(ctx: CanvasRenderingContext2D, d: TDrawOptions, last$: number) {
        if (!d) return last$;
        const { $, f, fftSize, fftOverlap } = d;
        if (!f || !f.length || !f[0].length) return last$;
        const fftBins = fftSize / 2;
        let $f = $ * fftOverlap / 2;
        $f -= $f % fftBins;
        const { width: canvasWidth, height: h } = ctx.canvas;
        const l = f[0].length;
        const $0 = wrap(last$, 0, l);
        const $1 = $0 >= $f ? $f + l : $f;
        if ($1 - $0 < 0) return last$;
        const $0fft = Math.floor($0 / fftBins);
        const $1fft = Math.ceil($1 / fftBins);
        const hCh = h / f.length;
        const w = l / fftBins;
        const $h = hCh / fftBins;
        if (canvasWidth !== w) ctx.canvas.width = w;
        const step = Math.max(1, Math.round(fftBins / hCh));
        for (let i = 0; i < f.length; i++) {
            for (let j = $0fft; j < $1fft; j++) {
                let maxInStep;
                ctx.fillStyle = "black";
                ctx.fillRect(j % w, i * hCh, 1, hCh);
                for (let k = 0; k < fftBins; k++) {
                    const samp = f[i][wrap(k, j * fftBins, l)];
                    const $step = k % step;
                    if ($step === 0) maxInStep = samp;
                    if ($step !== step - 1) {
                        if ($step !== 0 && samp > maxInStep) maxInStep = samp;
                        continue;
                    }
                    const normalized = Math.min(1, Math.max(0, (maxInStep + 10) / 100 + 1));
                    if (normalized === 0) continue;
                    const hue = (normalized * 180 + 240) % 360;
                    const lum = normalized * 50;
                    ctx.fillStyle = `hsl(${hue}, 100%, ${lum}%)`;
                    ctx.fillRect(j % w, (fftBins - k - 1) * $h + i * hCh, 1, Math.max(1, $h));
                }
            }
        }
        return wrap($1, 0, l);
    }
    static drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
        ctx.save();
        ctx.fillStyle = "#181818";
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
    }
    static drawGrid(
        canvas: CanvasRenderingContext2D, // Canvas
        canvasWidth: number, // canvas width
        canvasHeight: number, // canvas height
        samplesStart: number,
        samplesEnd: number,
        $zerox: number,
        yFactor: number,
        d: TDrawOptions,
        mode: EScopeMode,
        xLogMode?: TXLogMode
    ) {
        canvas.save();
        canvas.setLineDash([]);
        canvas.lineWidth = 1;
        const {
            t, // Time-domain data
            e, // gfds
            bufferSize, // buffer size
            fftSize, // fft block size
            fftOverlap, // fft overlap
            sampleRate // sample rate
        } = d;

        // Frequency domain if drawing a Spectro-thing
        const inFreqDomain = mode === EScopeMode.Spectrogram || mode === EScopeMode.Spectroscope;
        // The number of frequencies
        const fftBins = fftSize / 2;
        // The number of channels
        const channels = mode === EScopeMode.Oscilloscope ? 1 : t.length;
        // Scale units text
        const unit = mode === EScopeMode.Spectrogram ? "Hz/frame" : mode === EScopeMode.Spectroscope ? "dB/Hz(log10)" : "lvl/samp";

        // The array of events to draw
        const eventsToDraw: [number, { type: string; data: any }[]][] = [];

        let $0buffer = samplesStart / bufferSize / (inFreqDomain ? fftOverlap / 2 : 1);
        let $1buffer = samplesEnd / bufferSize / (inFreqDomain ? fftOverlap / 2 : 1);
        const hStep = 2 ** Math.ceil(Math.log2($1buffer - $0buffer)) / 8;

        $0buffer -= $0buffer % hStep;
        $1buffer -= $0buffer % hStep;

        let $buffer = (d.$buffer || 0) + Math.round($zerox / bufferSize / (inFreqDomain ? fftOverlap / 2 : 1));
        if (inFreqDomain) $buffer -= $buffer % (fftBins / bufferSize / fftOverlap / 2);

        const yAxisFromLeft = 50;
        const xAxisFromBottom = 20;
        const eventStrokeStyle = "#ff8800"; //  Orangy yellow
        const bufferStrokeStyle = "#004000"; // Feint green (the vertical lines)
        const normalStrokeStyle = "#404040"; // 75% Grey (the horizontal lines)
        canvas.fillStyle = "#DDDD99"; //        Light greeny/yellow
        canvas.font = "10px Consolas, monospace";
        canvas.textAlign = "right";
        canvas.textBaseline = "middle";
        canvas.fillText(unit, 45, canvasHeight - 10, 40);
        canvas.textAlign = "center";
        canvas.strokeStyle = "white";

        // Draw
        canvas.beginPath();
        canvas.moveTo(yAxisFromLeft, 0); // Top of Y axis
        canvas.lineTo(yAxisFromLeft, canvasHeight - xAxisFromBottom); // Draw the Y axis
        canvas.lineTo(canvasWidth, canvasHeight - xAxisFromBottom); //   Draw the X axis
        canvas.stroke(); // Fill the paths in in white

        // Change to Feint green X marker lines
        canvas.strokeStyle = bufferStrokeStyle;

        if (xLogMode && xLogMode.logBase) {
            const xWidth = canvasWidth - yAxisFromLeft;

            const { powers, suffixSteps, interPowerFactor } = xLogMode.getPowerSteps(sampleRate);

            canvas.strokeStyle = "white";
            const endSuffixLines = suffixSteps + 2;
            const interPowerSpace = xWidth * interPowerFactor;
            for (let c = 0; c <= powers; ++c) {
                // The tagged line for this frequency
                const tagFreq = xLogMode.logBase ** c;
                const x = xLogMode.logFunc(tagFreq) * interPowerSpace + yAxisFromLeft;
                canvas.beginPath();
                canvas.moveTo(x, 0);
                canvas.lineTo(x, canvasHeight - xAxisFromBottom);
                canvas.stroke();
                canvas.fillText(tagFreq.toFixed(), Math.min(x, canvasWidth - 20), canvasHeight - 10);

                canvas.strokeStyle = bufferStrokeStyle;
                // Now lines in between
                const stopFreq = c === powers ? endSuffixLines * tagFreq : xLogMode.logBase ** (c + 1);
                for (let lineFreq = tagFreq + tagFreq; lineFreq < stopFreq; lineFreq += tagFreq) {
                    canvas.beginPath();
                    const lineX = xLogMode.logFunc(lineFreq) * interPowerSpace + yAxisFromLeft;
                    canvas.moveTo(lineX, 0);
                    canvas.lineTo(lineX, canvasHeight - xAxisFromBottom);
                    canvas.stroke();
                }
            }
        } else {
            // Basically draw the guidelines - but the code is SO opaque!
            for (let j = $0buffer; j < $1buffer; j += hStep) {
                const $fft = j / (fftBins / bufferSize) * fftOverlap / 2;
                const x = (j * bufferSize * (inFreqDomain ? fftOverlap / 2 : 1) - samplesStart) / (samplesEnd - samplesStart - 1) * (canvasWidth - yAxisFromLeft) + yAxisFromLeft;
                if (x < yAxisFromLeft) continue;
                canvas.strokeStyle = j % 1 === 0 ? bufferStrokeStyle : normalStrokeStyle;
                canvas.beginPath();
                canvas.moveTo(x, 0);
                canvas.lineTo(x, canvasHeight - xAxisFromBottom);
                canvas.stroke();
                if (mode === EScopeMode.Spectrogram) { // TODO: Create 10**n labels
                    if ($fft % 1 === 0) canvas.fillText($fft.toFixed(), Math.min(x, canvasWidth - 20), canvasHeight - 10);
                } else if (mode === EScopeMode.Spectroscope) {
                    canvas.fillText((($fft % 1) * sampleRate / 2).toFixed(), Math.min(x, canvasWidth - 20), canvasHeight - 10);
                } else {
                    canvas.fillText((j * bufferSize).toFixed(), Math.min(x, canvasWidth - 20), canvasHeight - 10);
                }
            }
        }
        if (e) {
            canvas.strokeStyle = eventStrokeStyle;
            for (let j = Math.ceil($0buffer); j < $1buffer; j++) {
                if (e[$buffer + j] && e[$buffer + j].length) {
                    const x = (j * bufferSize * (inFreqDomain ? fftOverlap / 2 : 1) - samplesStart) / (samplesEnd - samplesStart - 1) * (canvasWidth - yAxisFromLeft) + yAxisFromLeft;
                    if (x < yAxisFromLeft) continue;
                    eventsToDraw.push([x, e[$buffer + j]]);
                    canvas.beginPath();
                    canvas.moveTo(x, 0);
                    canvas.lineTo(x, canvasHeight - xAxisFromBottom);
                    canvas.stroke();
                }
            }
        }
        canvas.strokeStyle = normalStrokeStyle;
        const hCh = (canvasHeight - xAxisFromBottom) / channels;
        let vStep = 0.25;
        while (yFactor / vStep > 2) vStep *= 2; // Maximum horizontal grids in channel one side = 2
        canvas.beginPath();
        canvas.textAlign = "right";
        const drawHLine = (y: number, yLabel: string) => {
            canvas.moveTo(yAxisFromLeft, y);
            canvas.lineTo(canvasWidth, y);
            canvas.fillText(yLabel, 45, Math.max(y, 10));
        };
        for (let i = 0; i < channels; i++) {
            let y = (i + 0.5) * hCh;
            let $ = 0.5;
            const getYLabel = () => (mode === EScopeMode.Spectrogram ? indexToFreq(fftBins * $, fftBins, sampleRate).toFixed(0) : mode === EScopeMode.Spectroscope ? (-100 + 100 * $).toFixed(0) : (-yFactor + 2 * yFactor * $).toFixed(2));
            let yLabel = getYLabel();
            drawHLine(y, yLabel);
            for (let j = vStep; j < yFactor; j += vStep) {
                $ = 0.5 - j / yFactor / 2;
                y = (i + 0.5 + j / yFactor / 2) * hCh;
                yLabel = getYLabel();
                drawHLine(y, yLabel);
                $ = 0.5 + j / yFactor / 2;
                y = (i + 0.5 - j / yFactor / 2) * hCh;
                yLabel = getYLabel();
                drawHLine(y, yLabel);
            }
        }
        canvas.stroke();
        canvas.beginPath();
        canvas.setLineDash([4, 2]);
        canvas.strokeStyle = "white";
        for (let i = 1; i < channels; i++) {
            canvas.moveTo(0, i * hCh);
            canvas.lineTo(canvasWidth, i * hCh);
        }
        canvas.stroke();
        canvas.restore();
        return eventsToDraw;
    }
    static drawEvent(ctx: CanvasRenderingContext2D, w: number, h: number, x: number, e: { type: string; data: any }[], xLogMode = 0) {
        ctx.save();
        ctx.font = "bold 12px Consolas, monospace";
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        const eStrings = e.map(event => (event.data.path ? `${event.data.path}: ${event.data.value}` : `${event.type}: ${event.data.join(",")}`));
        const textWidth = Math.max(...eStrings.map(s => ctx.measureText(s).width)) + 5;
        if (w - x >= textWidth) {
            ctx.fillRect(x, 0, textWidth, e.length * 15 + 2);
            ctx.textAlign = "left";
        } else {
            ctx.fillRect(x - textWidth, 0, textWidth, e.length * 15 + 2);
            ctx.textAlign = "right";
        }
        ctx.fillStyle = "#DDDD99";
        eStrings.forEach((s, i) => ctx.fillText(s, x, (i + 1) * 15, textWidth));
        ctx.restore();
    }
    static drawStats(ctx: CanvasRenderingContext2D, w: number, h: number, statsToDraw: { x?: number; y?: number; xLabel?: string; yLabel?: string; values: number[] }) {
        const left = 50;
        const bottom = 20;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#b0b0b0";
        ctx.beginPath();
        const { x, y, xLabel, yLabel, values } = statsToDraw;
        if (x) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h - bottom);
        }
        if (y) {
            ctx.moveTo(left, y);
            ctx.lineTo(w, y);
        }
        ctx.stroke();
        ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
        if (xLabel) ctx.fillRect(Math.min(x - 20, w - 40), h - 18, 40, 16);
        if (yLabel) ctx.fillRect(5, Math.max(0, y - 8), 45, 16);
        ctx.fillStyle = "#DDDD99";
        ctx.font = "bold 12px Consolas, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (xLabel) ctx.fillText(xLabel, Math.min(x, w - 20), h - 10, 40);
        ctx.textAlign = "right";
        if (yLabel) ctx.fillText(yLabel, 40, Math.max(10, y), 40);
        ctx.textBaseline = "bottom";
        const right: string[] = [];
        values.forEach(v => right.push(v.toFixed(7)));
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        ctx.fillRect(w - 70, 0, 80, right.length * 15 + 5);
        ctx.fillStyle = "#DDDD99";
        right.forEach((s, i) => ctx.fillText(s, w - 2, (i + 1) * 15, 70));
        ctx.restore();
    }
    static fillDivData(container: HTMLDivElement, d: TDrawOptions) {
        container.innerHTML = "";
        if (!d) return;
        const { $, t, e } = d;
        if (!t || !t.length || !t[0].length) return;
        const l = t[0].length;
        for (let i = 0; i < t.length; i++) {
            const ch = t[i];
            const divCh = document.createElement("div");
            divCh.classList.add("static-scope-channel");
            divCh.style.backgroundColor = t.length === 1 ? "#181818" : `hsl(${i * 60}, 100%, 10%)`;
            for (let j = 0; j < Math.min(ch.length, 2048); j++) {
                const $j = wrap(j, $, l);
                const divCell = document.createElement("div");
                divCell.classList.add("static-scope-cell");
                const $buffer = (d.$buffer || 0) + Math.floor(j / d.bufferSize);
                if (e && e[$buffer] && e[$buffer].length && j % d.bufferSize === 0) divCell.classList.add("highlight");
                const spanIndex = document.createElement("span");
                spanIndex.innerText = j.toString();
                const spanSamp = document.createElement("span");
                spanSamp.innerText = ch[$j].toFixed(7);
                divCell.appendChild(spanIndex);
                divCell.appendChild(spanSamp);
                divCh.appendChild(divCell);
            }
            if (ch.length > 2048) {
                const divCell = document.createElement("div");
                divCell.classList.add("static-scope-cell");
                const spanIndex = document.createElement("span");
                spanIndex.innerText = "...";
                const spanSamp = document.createElement("span");
                spanSamp.innerText = "...";
                divCell.appendChild(spanIndex);
                divCell.appendChild(spanSamp);
                divCh.appendChild(divCell);
            }
            container.appendChild(divCh);
        }
    }
    static getIconClassName(typeIn: EScopeMode) {
        const prefix = "fas fa-sm ";
        if (typeIn === EScopeMode.Data) return prefix + "fa-table";
        if (typeIn === EScopeMode.Interleaved) return prefix + "fa-water";
        if (typeIn === EScopeMode.Oscilloscope) return prefix + "fa-wave-square";
        if (typeIn === EScopeMode.Spectroscope) return prefix + "fa-chart-bar";
        if (typeIn === EScopeMode.Spectrogram) return prefix + "fa-align-justify";
        return prefix;
    }
    static getModeName(typeIn: EScopeMode) {
        if (typeIn === EScopeMode.Data) return "Data";
        if (typeIn === EScopeMode.Interleaved) return "Interleaved";
        if (typeIn === EScopeMode.Oscilloscope) return "Oscilloscope";
        if (typeIn === EScopeMode.Spectroscope) return "Spectroscope";
        if (typeIn === EScopeMode.Spectrogram) return "Spectrogram";
        return "";
    }

    constructor(options: TOptions) {
        Object.assign(this, options);
        this.getChildren();
        this.bind();
        this.mode = EScopeMode.Oscilloscope;
    }
    getChildren() {
        this.spectTempCtx = document.createElement("canvas").getContext("2d");
        this.spectTempCtx.canvas.height = 1024;
        let ctrl: HTMLDivElement;
        for (let i = 0; i < this.container.children.length; i++) {
            const e = this.container.children[i];
            if (e.classList.contains("static-scope-ui-controller")) ctrl = e as HTMLDivElement;
            if (e.classList.contains("static-scope-canvas")) this.canvas = e as HTMLCanvasElement;
            if (e.classList.contains("static-scope-data")) this.divData = e as HTMLDivElement;
            if (e.classList.contains("static-scope-default")) this.divDefault = e as HTMLDivElement;
        }
        if (!ctrl) {
            ctrl = document.createElement("div");
            ctrl.classList.add("static-scope-ui-controller");
            this.container.appendChild(ctrl);
        }
        if (!this.canvas) {
            const canvas = document.createElement("canvas");
            canvas.classList.add("static-scope-canvas");
            this.container.appendChild(canvas);
            this.canvas = canvas;
        }
        if (!this.divData) {
            const divData = document.createElement("div");
            divData.classList.add("static-scope-data");
            this.container.appendChild(divData);
            this.divData = divData;
        }
        if (!this.divDefault) {
            const divDefault = document.createElement("div");
            divDefault.classList.add("static-scope-default", "alert", "alert-info");
            divDefault.setAttribute("role", "alert");
            divDefault.innerHTML = "<h5>No Data</h5>";
            this.container.appendChild(divDefault);
            this.divDefault = divDefault;
        }
        this.ctx = this.canvas.getContext("2d");
        for (let i = 0; i < ctrl.children.length; i++) {
            const e = ctrl.children[i];
            if (e.classList.contains("static-scope-ui-switch")) this.btnSwitch = e as HTMLButtonElement;
            if (e.classList.contains("static-scope-ui-zoomout")) this.btnZoomOut = e as HTMLButtonElement;
            if (e.classList.contains("static-scope-ui-zoom")) this.btnZoom = e as HTMLButtonElement;
            if (e.classList.contains("static-scope-ui-zoomin")) this.btnZoomIn = e as HTMLButtonElement;
            if (e.classList.contains("static-scope-ui-download")) this.btnDownload = e as HTMLButtonElement;
        }
        if (!this.btnSwitch) {
            const btn = document.createElement("button");
            btn.className = "static-scope-ui-switch btn btn-outline-light btn-sm btn-overlay btn-overlay-icon";
            btn.setAttribute("data-toggle", "tooltip");
            btn.setAttribute("data-placement", "top");
            btn.setAttribute("title", "Interleaved Scope / Stacked Scope / Data");
            ctrl.appendChild(btn);
            try {
                $(btn).tooltip({ trigger: "hover", boundary: "viewport" });
            } catch (e) {} // eslint-disable-line no-empty
            this.btnSwitch = btn;
        }
        if (!this.btnZoomOut) {
            const btn = document.createElement("button");
            btn.className = "static-scope-ui-zoomout btn btn-outline-light btn-sm btn-overlay btn-overlay-icon";
            btn.setAttribute("data-toggle", "tooltip");
            btn.setAttribute("data-placement", "top");
            btn.setAttribute("title", "Zoom Out");
            btn.innerHTML = '<i class="fas fa-minus"></i>';
            ctrl.appendChild(btn);
            try {
                $(btn).tooltip({ trigger: "hover", boundary: "viewport" });
            } catch (e) {} // eslint-disable-line no-empty
            this.btnZoomOut = btn;
        }
        if (!this.btnZoom) {
            const btn = document.createElement("button");
            btn.className = "static-scope-ui-zoom btn btn-outline-light btn-sm btn-overlay";
            btn.setAttribute("data-toggle", "tooltip");
            btn.setAttribute("data-placement", "top");
            btn.setAttribute("title", "Reset Zoom");
            btn.innerText = "1.0x";
            ctrl.appendChild(btn);
            try {
                $(btn).tooltip({ trigger: "hover", boundary: "viewport" });
            } catch (e) {} // eslint-disable-line no-empty
            this.btnZoom = btn;
        }
        if (!this.btnZoomIn) {
            const btn = document.createElement("button");
            btn.className = "static-scope-ui-zoomin btn btn-outline-light btn-sm btn-overlay btn-overlay-icon";
            btn.setAttribute("data-toggle", "tooltip");
            btn.setAttribute("data-placement", "top");
            btn.setAttribute("title", "Zoom In");
            btn.innerHTML = '<i class="fas fa-plus"></i>';
            ctrl.appendChild(btn);
            try {
                $(btn).tooltip({ trigger: "hover", boundary: "viewport" });
            } catch (e) {} // eslint-disable-line no-empty
            this.btnZoomIn = btn;
        }

        if (!this.btnDownload) {
            const btn = document.createElement("button");
            btn.className = "static-scope-ui-download btn btn-outline-light btn-sm btn-overlay btn-overlay-icon";
            btn.setAttribute("data-toggle", "tooltip");
            btn.setAttribute("data-placement", "top");
            btn.setAttribute("title", "Download Data");
            btn.innerHTML = '<i class="fas fa-download"></i>';
            ctrl.appendChild(btn);
            try {
                $(btn).tooltip({ trigger: "hover", boundary: "viewport" });
            } catch (e) {} // eslint-disable-line no-empty
            this.btnDownload = btn;
        }

        for (let i = 0; i < this.btnSwitch.children.length; i++) {
            const e = this.btnSwitch.children[i];
            if (e.classList.contains("fas")) this.iSwitch = e as HTMLElement;
            if (e instanceof HTMLSpanElement) this.spanSwitch = e;
        }
        if (!this.iSwitch) {
            const i = document.createElement("i");
            i.className = "fas fa-sm fa-wave-square";
            this.btnSwitch.appendChild(i);
            this.iSwitch = i;
        }
        if (!this.spanSwitch) {
            const span = document.createElement("span");
            span.innerText = "Oscilloscope";
            this.btnSwitch.appendChild(span);
            this.spanSwitch = span;
        }
    }
    bind() {
        this.btnSwitch.addEventListener("click", () => {
            let newType = (this.mode + 1) % 5;
            if (newType === EScopeMode.Spectrogram && !this.drawSpectrogram) newType = (newType + 1) % 5;
            if (newType === EScopeMode.Data && this.data.drawMode === "continuous") newType = (newType + 1) % 5;
            if (newType === EScopeMode.Interleaved && this.data.t && this.data.t.length === 1) newType = (newType + 1) % 5;
            this.mode = newType;
        });
        this.canvas.addEventListener("click", () => {
        });
        this.canvas.addEventListener("wheel", (e) => {
            const left = 50;
            const bottom = 20;
            const multiplier = 1.5 ** (e.deltaY > 0 ? -1 : 1);
            if (e.offsetX < left && e.offsetY < this.canvas.height - bottom) {
                if (multiplier !== 1) this.vzoom *= 1 / multiplier;
                this.draw();
            } else {
                if (multiplier !== 1) this.zoom *= multiplier;
                if (e.deltaX !== 0) this.zoomOffset += (e.deltaX > 0 ? 1 : -1) * 0.1;
                this.handleMouseMove(e);
            }
        });
        this.btnZoomOut.addEventListener("click", () => {
            this.zoom /= 1.5;
            this.draw();
        });
        this.btnZoom.addEventListener("click", () => {
            this.zoom = 1;
            this.draw();
        });
        this.btnZoomIn.addEventListener("click", () => {
            this.zoom *= 1.5;
            this.draw();
        });
        this.btnDownload.addEventListener("click", () => {
            let data = "";
            if (this.mode === EScopeMode.Data || this.mode === EScopeMode.Interleaved || this.mode === EScopeMode.Oscilloscope) {
                if (this.data.t) {
                    const { t, $ } = this.data;
                    if (!t || !t.length || !t[0].length) return;
                    const l = t[0].length;
                    data += new Array(t.length).fill(null).map((v, i) => `channel${i + 1}`).join(",") + "\n";
                    for (let j = 0; j < l; j++) {
                        for (let i = 0; i < t.length; i++) {
                            const $j = wrap(j, $, l);
                            const samp = t[i][$j];
                            data += samp + (i === t.length - 1 ? "\n" : ",");
                        }
                    }
                }
            } else if (this.mode === EScopeMode.Spectroscope) {
                const { $, f, fftSize, fftOverlap } = this.data;
                if (!f || !f.length || !f[0].length) return;
                const fftBins = fftSize / 2;
                let $f = $ * fftOverlap / 2;
                $f -= $f % fftBins;
                const l = f[0].length;
                data += new Array(f.length).fill(null).map((v, i) => `channel${i + 1}`).join(",") + "\n";
                for (let j = l - fftBins; j < l; j++) {
                    for (let i = 0; i < f.length; i++) {
                        const $j = wrap(j, $f, l);
                        const samp = f[i][$j];
                        data += samp + (i === f.length - 1 ? "\n" : ",");
                    }
                }
            } else if (this.mode === EScopeMode.Spectrogram) {
                const { $, f, fftSize, fftOverlap } = this.data;
                if (!f || !f.length || !f[0].length) return;
                const fftBins = fftSize / 2;
                let $f = $ * fftOverlap / 2;
                $f -= $f % fftBins;
                const l = f[0].length;
                data += new Array(l / fftBins).fill(null).map((v, i) => new Array(f.length).fill(null).map((v, j) => `frame${i + 1}_channel${j + 1}`).join(",")).join(",") + "\n";
                for (let j = 0; j < fftBins; j++) {
                    for (let h = 0; h < l / fftBins; h++) {
                        for (let i = 0; i < f.length; i++) {
                            const $j = wrap(h * fftBins + j, $f, l);
                            const samp = f[i][$j];
                            data += samp + (i === f.length - 1 && h === l / fftBins - 1 ? "\n" : ",");
                        }
                    }
                }
            }
            if (!data) return;
            const blob = new Blob([data]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "data.csv";
            a.target = "_blank";
            a.click();
        });
        this.canvas.addEventListener("mousedown", this.handleMouseDown);
        this.canvas.addEventListener("touchstart", this.handleMouseDown);
        this.canvas.addEventListener("mousemove", this.handleMouseMove);
        this.canvas.addEventListener("touchmove", this.handleMouseMove);
        this.canvas.addEventListener("mouseleave", this.handleMouseLeave);
        this.canvas.addEventListener("touchend", this.handleMouseLeave);
    }
    drawCallback = () => {
        this.raf = undefined;
        if (!this.data || !this.data.t || !this.data.t.length || !this.data.t[0].length) {
            if (this.divDefault.style.display === "none") {
                this.divDefault.style.display = "block";
                return;
            }
        } else if (this.divDefault.style.display !== "none") this.divDefault.style.display = "none";
        if (this.data && this.newDataArrived && this.drawSpectrogram) this.lastSpect$ = StaticScope.drawOfflineSpectrogram(this.spectTempCtx, this.data, this.lastSpect$);
        if (this.data.drawMode === "continuous" && this.canvas.offsetParent === null) return; // not visible
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        if (this.mode === EScopeMode.Data) StaticScope.fillDivData(this.divData, this.data);
        else if (this.mode === EScopeMode.Interleaved) StaticScope.drawInterleaved(this.ctx, w, h, this.data, this.zoom, this.zoomOffset, this.vzoom, this.cursor);
        else if (this.mode === EScopeMode.Oscilloscope) StaticScope.drawOscilloscope(this.ctx, w, h, this.data, this.zoom, this.zoomOffset, this.vzoom, this.cursor);
        else if (this.mode === EScopeMode.Spectroscope) StaticScope.drawSpectroscope(this.ctx, w, h, this.data, this.zoom, this.zoomOffset, this.cursor);
        else if (this.mode === EScopeMode.Spectrogram) StaticScope.drawSpectrogram(this.ctx, this.spectTempCtx, w, h, this.data, this.zoom, this.zoomOffset, this.cursor);
        this.newDataArrived = false;
    };
    draw = (data?: TDrawOptions) => {
        if (data) {
            this.data = data;
            this.newDataArrived = true;
        }
        if (this.raf) return;
        this.raf = requestAnimationFrame(this.drawCallback);
    }
    get zoomType() {
        return this.mode === EScopeMode.Spectroscope
            ? "spectroscope"
            : this.mode === EScopeMode.Spectrogram
                ? "spectrogram"
                : "oscilloscope";
    }
    get vzoom() {
        return this._vzoom[this.zoomType];
    }
    set vzoom(zoomIn) {
        const maxZoom = 16;
        this._vzoom[this.zoomType] = Math.min(maxZoom, Math.max(1, zoomIn));
    }
    get zoom() {
        return this._zoom[this.zoomType];
    }
    set zoom(zoomIn) {
        const maxZoom = this.data && this.data.t && this.data.t[0] ? Math.max(16, this.mode === EScopeMode.Spectroscope ? 16 : this.data.t[0].length / (this.inFreqDomain ? this.data.fftSize / 2 : this.data.bufferSize)) : 16;
        const w = this.canvas.width;
        let cursorIn = 0.5;
        const left = 50;
        if (this.cursor) cursorIn = Math.max(0, this.cursor.x - left) / (w - left);
        const cursor = this.zoomOffset + cursorIn / this.zoom;
        this._zoom[this.zoomType] = Math.min(maxZoom, Math.max(1, zoomIn));
        this.zoomOffset = cursor - cursorIn / this.zoom;
        this.btnZoom.innerHTML = this.zoom.toFixed(1) + "x";
    }
    get zoomOffset() {
        return this._zoomOffset[this.zoomType];
    }
    set zoomOffset(zoomOffsetIn) {
        this._zoomOffset[this.zoomType] = Math.max(0, Math.min(1 - 1 / this.zoom, zoomOffsetIn));
    }
    resetZoom() {
        this._zoom = { oscilloscope: 1, spectroscope: 1, spectrogram: 1 };
        this._zoomOffset = { oscilloscope: 0, spectroscope: 0, spectrogram: 0 };
    }

    get mode() {
        return this._mode;
    }
    set mode(modeIn) {
        this.iSwitch.className = StaticScope.getIconClassName(modeIn);
        this.spanSwitch.innerText = StaticScope.getModeName(modeIn);
        this._mode = modeIn;
        if (modeIn === EScopeMode.Data) {
            this.divData.style.display = "";
            this.canvas.style.display = "none";
            this.btnZoom.style.display = "none";
            this.btnZoomIn.style.display = "none";
            this.btnZoomOut.style.display = "none";
        } else {
            this.divData.style.display = "none";
            this.canvas.style.display = "";
            this.btnZoom.style.display = "";
            this.btnZoomIn.style.display = "";
            this.btnZoomOut.style.display = "";
        }
        this.draw();
    }
    get inFreqDomain() {
        return this.mode === EScopeMode.Spectrogram || this.mode === EScopeMode.Spectroscope;
    }
}
