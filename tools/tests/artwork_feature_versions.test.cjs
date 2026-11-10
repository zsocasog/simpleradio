const assert=require('node:assert/strict'),test=require('node:test');
const {parse}=require('./helpers/artwork_track_parts.cjs');
const {query,exact,exactWithTypos,subtitle,creditTitle,artistsMatch,prepare}=require('./helpers/artwork_credit_match.cjs');

test('CNCO explicit remix survives the Little Mix feature credit',()=>{
  assert.equal(exact('CNCO & Little Mix','Reggaetón Lento (Remix)','CNCO','Reggaeton Lento (Remix) feat. Little Mix'),true);
  assert.equal(exact('CNCO & Little Mix','Reggaetón Lento (Remix)','CNCO','Reggaeton Lento feat. Little Mix (Remix)'),true);
  assert.equal(exact('CNCO & Little Mix','Reggaetón Lento (Remix)','CNCO','Reggaeton Lento (feat. Little Mix) (Remix)'),true);
});

test('version annotations before or after a feature keep the same identity',()=>{
  for(const version of ['Remix','Radio Edit','Extended Mix','Club Mix','Acoustic','Live','2020 Remaster']) {
    for(const suffix of [`feat. Little Mix (${version})`,`ft. Little Mix - ${version}`,`FEATURING Little Mix – ${version}`,`with Little Mix — ${version}`]) {
      assert.equal(exact('CNCO & Little Mix',`Song (${version})`,'CNCO',`Song ${suffix}`),true,suffix);
    }
  }
});

test('mix, live and digits inside proven guest names are not version filters',()=>{
  for(const guest of ['Little Mix','Mix Master Mike','Live','Maroon 5','The Remix']) {
    assert.equal(exact(`Artist & ${guest}`,'Song','Artist',`Song feat. ${guest}`),true,guest);
  }
});

test('ambiguous unbracketed suffixes require complete provider credit evidence',()=>{
  assert.equal(exact('CNCO & Little Mix','Song (Remix)','CNCO','Song feat. Little Mix Remix'),true);
  assert.equal(exact('CNCO','Song (Remix)','CNCO','Song feat. Little Mix Remix'),false);
  assert.equal(exact('Artist & The Remix','Song','Artist','Song feat. The Remix'),true);
  assert.equal(exact('Artist & Little','Song','Artist','Song feat. Little Mix'),false);
});

test('a requested guest must be present; another guest cannot replace it',()=>{
  assert.equal(exact('Ofenbach & Another Guest','Katchi feat. Another Guest','Ofenbach','Katchi feat. Nick Waterhouse'),false);
  assert.equal(exact('Ofenbach & Another Guest','Katchi','Ofenbach','Katchi feat. Nick Waterhouse'),false);
  assert.equal(exact('Ofenbach & Nick Waterhouse & Another Guest','Katchi','Ofenbach','Katchi feat. Nick Waterhouse'),false);
  assert.equal(exact('Ofenbach','Katchi feat. Nick Waterhouse','Ofenbach','Katchi feat. Nick Waterhouse'),true);
  assert.equal(exact('Nick Waterhouse','Katchi','Ofenbach','Katchi feat. Nick Waterhouse'),false);
});

test('conflicting explicit title credit stays rejected even when the artist list includes the requested guest',()=>{
  assert.equal(exact('Ofenbach & Nick Waterhouse','Katchi feat. Another Guest','Ofenbach','Katchi feat. Nick Waterhouse'),false);
});

test('missing, different or added versions never pass as the requested remix',()=>{
  const wanted='Song (Remix) feat. Little Mix';
  for(const title of ['Song','Song (Other Remix)','Song (Remix) [Sped Up]','Song (Live)','Song (Karaoke Version)','Different Song (Remix)']) {
    assert.equal(exact('CNCO & Little Mix',title,'CNCO',wanted),false,title);
  }
  assert.equal(exact('CNCO & Little Mix','Song (Remix)','CNCO','Song feat. Little Mix'),false);
  assert.equal(exact('Artist & Guest','Song (Other Mix)','Artist','Song (Club Mix) feat. Guest',true,true),false);
  assert.equal(exact('Artist & Guest','Song (Club Mix)','Artist','Song feat. Guest',true,true),false);
  assert.equal(exact('Artist & Guest','Song (Tchad Blake Mix)','Artist','Song feat. Guest',true,true),true);
});

test('title typo tolerance cannot change the named remixer or a protected version',()=>{
  // Adversarial typo approval must still be stopped by exact version identity.
  const match=exactWithTypos(()=>true);
  assert.equal(match('CNCO & Little Mix','Song (DJ B Remix)','CNCO','Song (DJ A Remix) feat. Little Mix',false,true),false);
  assert.equal(match('CNCO & Little Mix','Song DJ B Remix','CNCO','Song DJ A Remix feat. Little Mix',false,true),false);
  assert.equal(match('CNCO & Little Mix','Song (DJ A Remix) [Sped Up]','CNCO','Song (DJ A Remix) feat. Little Mix',false,true),false);
  assert.equal(match('CNCO & Little Mix','Snog (DJ A Remix)','CNCO','Song (DJ A Remix) feat. Little Mix',false,true),true);
});

test('verified artist aliases retain the real provider guest credit',()=>{
  const aliases=['atc','a touch of class'];
  assert.equal(exact('A Touch of Class & Guest','Song','ATC','Song feat. Guest',false,false,aliases),true);
  assert.equal(exact('A Touch of Class & Wrong Guest','Song','ATC','Song feat. Guest',false,false,aliases),false);
  assert.equal(exact('A Touch of Class & Wrong Guest','Song feat. Guest','ATC','Song feat. Guest',false,false,aliases),false);
});

test('optional-subtitle and artist-credit title matches cannot bypass guest checks',()=>{
  assert.equal(subtitle('Ofenbach & Another Guest','Katchi (Extra)','Ofenbach','Katchi feat. Nick Waterhouse'),false);
  assert.equal(creditTitle('Ofenbach & Another Guest','Katchi (Ofenbach & Another Guest)','Ofenbach','Katchi feat. Nick Waterhouse'),false);
  assert.equal(creditTitle('CNCO & Little Mix','Song (CNCO & Little Mix)','CNCO','Song feat. Little Mix'),true);
});

test('known credits prove space-only lists without discarding extra words',()=>{
  assert.equal(artistsMatch('Robbie Williams & Kylie Minogue','Robbie Williams Kylie Minogue'),true);
  assert.equal(artistsMatch('Kylie Minogue Robbie Williams','Robbie Williams & Kylie Minogue'),true);
  assert.equal(artistsMatch('CNCO & Little Mix','CNCO Little Mix'),true);
  assert.equal(artistsMatch('CNCO & Little Mix','CNCO Little Mix Tribute'),false);
  assert.equal(artistsMatch('R & R','R+R'),false);
  assert.equal(artistsMatch('The The','The'),false);
});

test('multiple requested guests support explicit joiners and ordering',()=>{
  for(const joiner of [' + ',' & ', ', ', ' feat. ', ' featuring ']) {
    assert.equal(exact('Main & First Guest & Second Guest','Song','Main',`Song feat. First Guest${joiner}Second Guest`),true,joiner);
  }
  assert.equal(exact('Main & First Guest','Song','Main','Song feat. First Guest & Second Guest'),false);
  assert.equal(exact('Main & First Guest','Song feat. Second Guest','Main','Song feat. First Guest & Second Guest'),true);
  assert.equal(exact('Main & First Guest & Second Guest','Song feat. Second Guest','Main','Song feat. First Guest & Second Guest'),true);
  assert.equal(exact('Main & First Guest','Song feat. Wrong Guest','Main','Song feat. First Guest & Second Guest'),false);
});

test('punctuation belonging to song titles or ordinary with titles is preserved',()=>{
  assert.equal(parse('Májusi, májusi').feature,false);
  assert.equal(exact('Nótár Mary','Májusban','Nótár Mary','Májusi, májusi'),false);
  assert.equal(exact('Sam Smith','Stay With Me','Sam Smith','Stay With Me'),true);
  assert.equal(exact('Artist & Sam Smith','Stay With Me','Artist','Stay With Me feat. Sam Smith'),true);
  assert.equal(exact('Artist & Sam Smith','Stay','Artist','Stay With Me feat. Sam Smith'),false);
  assert.equal(parse('Song (feat. Guest').valid,false);
});

test('raw parser retains brackets, version boundaries and standalone plus artist names',()=>{
  assert.deepEqual(parse('Song (feat. Little Mix) [Remix]'),{main:'Song',guest:'Little Mix',version:'',tail:'[Remix]',feature:true,valid:true,explicitCredit:true});
  assert.equal(parse('Song featuring +44 (Live)').guest,'+44');
  assert.equal(parse('Song feat. Little Mix Remix').guest,'Little Mix Remix');
  assert.deepEqual(prepare('Artist & Guest','Artist','Song','Song feat. Guest'),{ok:true,foundTitle:'Song',wantedTitle:'Song'});
});

test('provider queries preserve the explicit version after a guest credit',()=>{
  assert.equal(query('Song feat. Little Mix (Remix)'),'Song (Remix)');
  assert.equal(query('Song (feat. Little Mix) [Extended Mix]'),'Song [Extended Mix]');
  assert.equal(query('Song feat. Little Mix – Club Mix'),'Song Club Mix');
  assert.equal(query('Májusi, májusi'),'Májusi, májusi');
});
