package io.github.rithwikbabu.packwright.capture;

/** Deterministic, dependency-free measurements over exact ABGR framebuffers. */
final class ClientPixelAnalysis {
    private static final int EDGE_BAND_PIXELS = 2;

    private ClientPixelAnalysis() {}

    static SubjectMask compare(int[] subject, int[] emptyControl, int width, int height) {
        if (width <= 0 || height <= 0 || subject.length != width * height
                || emptyControl.length != subject.length) {
            throw new IllegalArgumentException("Framebuffer dimensions do not match pixel arrays.");
        }
        long changed = 0;
        long edgeChanged = 0;
        for (int index = 0; index < subject.length; index++) {
            if (subject[index] == emptyControl[index]) continue;
            changed++;
            int x = index % width;
            int y = index / width;
            if (x < EDGE_BAND_PIXELS
                    || y < EDGE_BAND_PIXELS
                    || x >= width - EDGE_BAND_PIXELS
                    || y >= height - EDGE_BAND_PIXELS) {
                edgeChanged++;
            }
        }
        return new SubjectMask(changed, subject.length, edgeChanged);
    }

    static double changedPercent(int[] left, int[] right, int width, int height) {
        return compare(left, right, width, height).coverageRatio() * 100.0;
    }

    static double meanAbsoluteLuminanceDeltaPercent(
            int[] left, int[] right, int width, int height) {
        validate(left, right, width, height);
        double sum = 0.0;
        for (int index = 0; index < left.length; index++) {
            sum += Math.abs(luminance(left[index]) - luminance(right[index]));
        }
        return left.length == 0 ? 0.0 : sum * 100.0 / (255.0 * left.length);
    }

    static double retainedSubjectPercent(
            int[] occluded,
            int[] visible,
            int[] emptyControl,
            int width,
            int height) {
        validate(visible, emptyControl, width, height);
        validate(occluded, emptyControl, width, height);
        long subjectPixels = 0;
        long retainedPixels = 0;
        for (int index = 0; index < visible.length; index++) {
            if (visible[index] == emptyControl[index]) continue;
            subjectPixels++;
            if (occluded[index] != emptyControl[index]) retainedPixels++;
        }
        return subjectPixels == 0 ? 0.0 : 100.0 * retainedPixels / subjectPixels;
    }

    static HitboxQa hitboxQa(
            int[] debug,
            int[] authoritative,
            int[] emptyControl,
            int width,
            int height) {
        validate(debug, authoritative, width, height);
        validate(authoritative, emptyControl, width, height);
        Bounds overlay = bounds(debug, authoritative, width, height);
        Bounds subject = bounds(authoritative, emptyControl, width, height);
        if (overlay == null || subject == null) return new HitboxQa(0.0, 100.0, 0.0);
        long subjectPixels = 0;
        long subjectInsideOverlay = 0;
        long subjectPixelsInOverlayBox = 0;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int index = y * width + x;
                boolean subjectPixel = authoritative[index] != emptyControl[index];
                if (subjectPixel) subjectPixels++;
                if (overlay.contains(x, y) && subjectPixel) {
                    subjectInsideOverlay++;
                    subjectPixelsInOverlayBox++;
                }
            }
        }
        double containment = subjectPixels == 0
                ? 0.0
                : 100.0 * subjectInsideOverlay / subjectPixels;
        double empty = overlay.area() == 0
                ? 100.0
                : 100.0 * (overlay.area() - subjectPixelsInOverlayBox) / overlay.area();
        double footprintDelta = Math.abs(overlay.area() - subject.area());
        return new HitboxQa(containment, empty, footprintDelta);
    }

    private static Bounds bounds(int[] left, int[] right, int width, int height) {
        int minX = width;
        int minY = height;
        int maxX = -1;
        int maxY = -1;
        for (int index = 0; index < left.length; index++) {
            if (left[index] == right[index]) continue;
            int x = index % width;
            int y = index / width;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
        return maxX < 0 ? null : new Bounds(minX, minY, maxX, maxY);
    }

    private static void validate(int[] left, int[] right, int width, int height) {
        if (width <= 0 || height <= 0 || left.length != width * height
                || right.length != left.length) {
            throw new IllegalArgumentException("Framebuffer dimensions do not match pixel arrays.");
        }
    }

    private static double luminance(int abgr) {
        int red = abgr & 0xff;
        int green = (abgr >>> 8) & 0xff;
        int blue = (abgr >>> 16) & 0xff;
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    }

    record SubjectMask(long changedPixels, long totalPixels, long edgeChangedPixels) {
        double coverageRatio() {
            return totalPixels == 0 ? 0.0 : (double) changedPixels / totalPixels;
        }

        /**
         * A conservative 2-D clipping proxy: 100 when the observed subject mask
         * does not touch the two-pixel framebuffer edge band, and lower in
         * proportion to mask pixels touching that band. It does not infer
         * off-screen geometry.
         */
        double frameRetentionPercent() {
            if (changedPixels == 0) return 0.0;
            return 100.0 * (1.0 - (double) edgeChangedPixels / changedPixels);
        }
    }

    record HitboxQa(
            double containmentPercent,
            double emptySpacePercent,
            double footprintDeltaPixels) {}

    private record Bounds(int minX, int minY, int maxX, int maxY) {
        boolean contains(int x, int y) {
            return x >= minX && x <= maxX && y >= minY && y <= maxY;
        }

        long area() {
            return (long) (maxX - minX + 1) * (maxY - minY + 1);
        }
    }
}
