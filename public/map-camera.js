(function(root){
  const WIDTH=800,HEIGHT=540;
  function create(){return {x:0,y:0,width:WIDTH,height:HEIGHT};}
  function zoom(camera,factor,anchorX=.5,anchorY=.5){
    const width=Math.max(WIDTH/10,Math.min(WIDTH*2,camera.width*factor));
    const height=width*HEIGHT/WIDTH;
    return {x:camera.x+(camera.width-width)*anchorX,y:camera.y+(camera.height-height)*anchorY,width,height};
  }
  function pan(camera,dx,dy){return {...camera,x:Math.max(-WIDTH*3,Math.min(WIDTH*3,camera.x+dx)),y:Math.max(-HEIGHT*3,Math.min(HEIGHT*3,camera.y+dy))};}
  function center(camera,x,y){return {...camera,x:x-camera.width/2,y:y-camera.height/2};}
  const api={create,zoom,pan,center};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ProLiftMapCamera=api;
})(typeof globalThis!=='undefined'?globalThis:this);
