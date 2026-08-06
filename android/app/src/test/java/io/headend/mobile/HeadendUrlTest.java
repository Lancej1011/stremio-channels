package io.headend.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class HeadendUrlTest {
    @Test public void acceptsTokenizedWatchUrl() {
        assertEquals(
            "https://box.example.ts.net/private_token",
            HeadendUrl.root("https://box.example.ts.net/private_token/watch/")
        );
    }

    @Test public void preservesBareServerRoot() {
        assertEquals("http://100.1.2.3:7654", HeadendUrl.root("http://100.1.2.3:7654"));
    }

    @Test public void rejectsIncompleteAddress() {
        assertThrows(IllegalArgumentException.class, () -> HeadendUrl.root("box.example/watch"));
    }
}
