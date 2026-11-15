'use strict';
const LGTC = require('../lgtc.cjs');
const { workbook } = require('../excel.cjs');

function plannerDemo(scenario) {
  const date = '2026-11-03';
  const confirmed = scenario === 'confirmed';
  const rows = ['08:00','09:00',confirmed ? '10:00' : '00:00'].map((time,index)=>{
    const row = Array(38).fill('');
    Object.assign(row,{0:'MCD1',1:'99-80'+(index+1)+'-A',2:'11/03/2026',
      3:index===1?'W':'A',4:'Test Rider '+(index+1),7:'Central Station',
      10:'Charlotte',11:'NC',12:'28202',14:time,16:'City Hospital',
      19:'Charlotte',20:'NC',21:'28202',23:['08:25','09:25','10:25'][index],
      28:'704555010'+(index+1)});
    return row;
  });
  const batch = LGTC.detect('LGTC_Demo.xlsx',workbook(rows).toString('base64'), key=>key);
  const shift = {days:[2],start:420,end:720};
  const roster = [
    {id:'maya',name:'Maya Chen',vehicleId:'demo-car',vehicle:'4-seat car',seats:4,capabilities:[],recurringShift:shift},
    {id:'james',name:'James Wilson',vehicleId:'demo-van',vehicle:'Accessible van',seats:7,capabilities:['wheelchair'],recurringShift:shift}
  ].filter(driver=>scenario!=='disabled' || driver.id!=='james');
  const preferences = new Map([[batch.rows[0].customerKey,{id:'maya',name:'Maya Chen'}]]);
  return LGTC.plan(batch,{serviceDate:date,buffer:15,driverIds:roster.map(driver=>driver.id),
    profiles:{A:{mode:'standard',base:1,extras:[]},W:{mode:'accessible',base:1,extras:[]}}},{roster,preferences});
}
module.exports = { plannerDemo };

