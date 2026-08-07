package io.headend.mobile;

import java.net.URI;
import java.net.URISyntaxException;

final class HeadendUrl {
    private HeadendUrl() {}

    static String root(String viewerUrl) {
        if (viewerUrl == null) throw new IllegalArgumentException("Viewer URL is required");
        String value = viewerUrl.trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        if (value.endsWith("/watch")) value = value.substring(0, value.length() - 6);
        try {
            URI uri = new URI(value);
            if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null) {
                throw new IllegalArgumentException("Use a complete http:// or https:// Watch URL");
            }
            return value;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("The Watch URL is not valid", error);
        }
    }

    static String endpoint(String root, String path) {
        return root + "/" + (path.startsWith("/") ? path.substring(1) : path);
    }
}
