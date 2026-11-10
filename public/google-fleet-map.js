// Keep the fleet's map data and interactions shared with the local map fallback.
window.ProLiftGoogleFleetMap = (() => {
  let loading;
  const position = ([lat, lng]) => ({ lat, lng });

  function load(key, authFailed) {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const callback = 'proLiftGoogleMapsReady';
      const finish = (error, provider) => {
        clearTimeout(timeout);
        delete window[callback];
        if (error) { script.remove(); reject(error); }
        else resolve(provider);
      };
      const timeout = setTimeout(() => finish(Error('Google Maps timed out')), 12000);
      window.gm_authFailure = () => {
        authFailed();
        finish(Error('Google Maps rejected the key'));
      };
      window[callback] = () => {
        const maps = window.google?.maps;
        if (!maps?.Map || !maps.marker?.AdvancedMarkerElement) {
          finish(Error('Google Maps libraries did not load'));
          return;
        }
        finish(null, provider(maps));
      };
      const params = new URLSearchParams({ key, callback, loading:'async', libraries:'marker', v:'quarterly' });
      script.src = 'https://maps.googleapis.com/maps/api/js?' + params;
      script.nonce = document.querySelector('script[nonce]')?.nonce || '';
      script.async = true;
      script.onerror = () => finish(Error('Google Maps could not load'));
      document.head.append(script);
    });
    return loading;
  }

  function provider(maps) {
    function map(node) {
      const layers = new Set();
      let view, fitListener;
      return {
        setView(point, zoom) {
          if (view) { view.setCenter(position(point)); view.setZoom(zoom); }
          else view = new maps.Map(node, {
            center:position(point), zoom, mapId:'DEMO_MAP_ID', tilt:0, heading:0,
            clickableIcons:false, gestureHandling:'greedy', streetViewControl:false,
            mapTypeControl:false, fullscreenControl:false, cameraControl:false, zoomControl:true
          });
          return this;
        },
        panTo(point) { view.panTo(position(point)); },
        fitBounds(points, { padding:[padding], maxZoom }) {
          const bounds = new maps.LatLngBounds();
          points.forEach(point => bounds.extend(position(point)));
          fitListener?.remove();
          if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
            this.setView(points[0], maxZoom);
            return;
          }
          fitListener = maps.event.addListenerOnce(view, 'idle', () => {
            if (view.getZoom() > maxZoom) view.setZoom(maxZoom);
          });
          view.fitBounds(bounds, padding);
        },
        on(events, listener) {
          view.addListener(events.includes('dragstart') ? 'dragstart' : 'idle', listener);
        },
        attach(layer) { layer.show(view); layers.add(layer); },
        remove() {
          fitListener?.remove();
          for (const layer of layers) layer.hide();
          layers.clear();
          maps.event.clearInstanceListeners(view);
          node.replaceChildren();
        },
        invalidateSize() {}
      };
    }
    function layerGroup() {
      let owner;
      const layers = new Set();
      const group = {
        addTo(target) { target.attach(group); return group; },
        show(view) { owner = view; },
        hide() { group.clearLayers(); owner = null; },
        attach(layer) { layer.show(owner); layers.add(layer); },
        clearLayers() {
          for (const layer of layers) layer.hide();
          layers.clear();
        }
      };
      return group;
    }
    function marker(point, { icon, title, zIndexOffset }) {
      const container = document.createElement('div');
      container.className = icon.className;
      container.innerHTML = icon.html;
      const pin = new maps.marker.AdvancedMarkerElement({
        position:position(point), title, zIndex:zIndexOffset || 700,
        anchorLeft:'-' + icon.iconAnchor[0] + 'px', anchorTop:'-' + icon.iconAnchor[1] + 'px'
      });
      pin.append(container);
      let clickHandler;
      return {
        addTo(target) { target.attach(this); return this; },
        show(view) { pin.map = view; },
        hide() {
          if (clickHandler) pin.removeEventListener('gmp-click', clickHandler);
          pin.map = null;
        },
        on(event, handler) {
          if (event !== 'click') return this;
          pin.gmpClickable = true;
          clickHandler = handler;
          pin.addEventListener('gmp-click', handler);
          return this;
        },
        bindTooltip(html, options = {}) {
          const caption = document.createElement('span');
          caption.innerHTML = html;
          pin.title = options.permanent ? caption.textContent : (title || caption.textContent);
          if (options.permanent) {
            caption.className = 'google-fleet-caption' + (options.direction === 'bottom' ? ' below' : '');
            pin.append(caption);
          }
          return this;
        },
        bindPopup() { return this; }
      };
    }
    function circleMarker(point, opts) {
      const diameter = opts.radius * 2;
      const svg = '<svg width="' + diameter + '" height="' + diameter + '" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="' +
        opts.fillColor + '" stroke="' + opts.color + '" stroke-width="' + opts.weight + '"/></svg>';
      return marker(point, { icon:{className:'google-fleet-stop',iconAnchor:[opts.radius,opts.radius],html:svg}, zIndexOffset:500 });
    }
    function polyline(points, opts) {
      const line = new maps.Polyline({
        path:points.map(position), clickable:false, strokeColor:opts.color, strokeWeight:opts.weight,
        strokeOpacity:opts.dashArray ? 0 : (opts.opacity ?? 1),
        icons:opts.dashArray ? [{ icon:{path:'M 0,-1 0,1',strokeOpacity:opts.opacity ?? 1,scale:3},offset:'0',repeat:'14px' }] : undefined
      });
      return {
        addTo(target) { target.attach(this); return this; },
        show(view) { line.setMap(view); },
        hide() { line.setMap(null); },
        setLatLngs(path) { line.setPath(path.map(position)); },
        bindTooltip() { return this; }
      };
    }
    return { map, layerGroup, marker, divIcon:opts=>opts, circleMarker, polyline };
  }
  return { load };
})();
